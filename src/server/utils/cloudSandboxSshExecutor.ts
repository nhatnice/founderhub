/**
 * Cloud Sandbox SSH Executor
 *
 * When CLOUD_SANDBOX_SSH_* env vars are configured, all CloudSandbox builtin tool
 * calls are routed here instead of the Market API. No Market authorization required.
 *
 * Authoritative tool list: every this.callService() call in ComputerRuntime.ts (12)
 * plus executeCode from CloudSandboxExecutionRuntime.ts = 13 toolNames total.
 * exportFileViaSsh covers the 14th operation (exportAndUploadFile path).
 *
 * Structured tools run a base64-encoded Python script via SSH for encoding-safe,
 * injection-proof, structured JSON results. Shell-exec tools (runCommand, executeCode)
 * run user code directly via subprocess inside that same Python wrapper.
 */
import crypto from 'node:crypto';

import type { SandboxCallToolResult } from '@lobechat/builtin-tool-cloud-sandbox';
import debug from 'debug';

import { appEnv } from '@/envs/app';

import { cloudSandboxSshRun } from './cloudSandboxSshRunner';

const log = debug('lobe-server:cloud-sandbox-ssh-executor');

// ──────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────

function getWorkdir(): string {
  return appEnv.CLOUD_SANDBOX_SSH_WORKDIR || '/workspace';
}

function ok(result: Record<string, unknown>): SandboxCallToolResult {
  return { result, sessionExpiredAndRecreated: false, success: true };
}

function fail(message: string, name = 'SshExecError'): SandboxCallToolResult {
  return {
    error: { message, name },
    result: null,
    sessionExpiredAndRecreated: false,
    success: false,
  };
}

/**
 * Build a Python script that decodes params from an embedded base64 JSON blob,
 * chdirs to workdir, then runs `body`.
 * The script always exits 0 and must print a single JSON line to stdout.
 * Errors are returned as {"error": "...message..."} in that JSON.
 */
function buildPyScript(params: Record<string, unknown>, body: string): string {
  const paramsB64 = Buffer.from(JSON.stringify({ ...params, __workdir: getWorkdir() })).toString(
    'base64',
  );
  return [
    'import base64, json, os, sys',
    `params = json.loads(base64.b64decode('${paramsB64}').decode('utf-8'))`,
    '_wd = params.get("__workdir", "/workspace")',
    'try:',
    '    os.makedirs(_wd, exist_ok=True)',
    '    os.chdir(_wd)',
    'except Exception:',
    '    pass',
    body,
  ].join('\n');
}

/**
 * Base64-encode a Python script and run it on the VPS via:
 *   echo <b64> | base64 -d | python3
 * Returns the parsed JSON object from stdout.
 * Throws on SSH error or non-JSON stdout.
 */
async function runPy(script: string): Promise<Record<string, unknown>> {
  const b64 = Buffer.from(script).toString('base64');
  const { exitCode, stderr, stdout } = await cloudSandboxSshRun(
    `echo ${b64} | base64 -d | python3`,
  );
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `Python exited with code ${exitCode}`);
  }
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`Non-JSON response from SSH: ${stdout.slice(0, 300)}`);
  }
}

/** Build + run a Python script, mapping errors to SandboxCallToolResult. */
async function runPyTool(
  params: Record<string, unknown>,
  body: string,
): Promise<SandboxCallToolResult> {
  try {
    const result = await runPy(buildPyScript(params, body));
    if (typeof result.error === 'string') return fail(result.error);
    return ok(result);
  } catch (err) {
    return fail((err as Error).message);
  }
}

// ──────────────────────────────────────────────────────────────
// Tool implementations
// ──────────────────────────────────────────────────────────────

function listLocalFiles(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
  return runPyTool(
    params,
    `
try:
    import stat as _stat
    d = params['directoryPath']
    entries = sorted(os.scandir(d), key=lambda e: e.name)
    files = []
    for e in entries:
        try:
            s = e.stat()
            files.append({
                'isDirectory': e.is_dir(),
                'name': e.name,
                'path': e.path,
                'size': s.st_size if not e.is_dir() else None,
            })
        except OSError:
            files.append({'isDirectory': e.is_dir(), 'name': e.name, 'path': e.path, 'size': None})
    print(json.dumps({'files': files, 'totalCount': len(files)}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`,
  );
}

function readLocalFile(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
  return runPyTool(
    params,
    `
try:
    path = params['path']
    with open(path, 'r', errors='replace') as f:
        all_text = f.read()
    all_lines = all_text.splitlines(keepends=True)
    total_lines = len(all_lines)
    total_chars = len(all_text.encode('utf-8'))
    start = params.get('startLine')
    end = params.get('endLine')
    if start is not None and end is not None:
        selected = all_lines[int(start)-1:int(end)]
        content = ''.join(selected)
        loc = [int(start), int(end)]
    else:
        content = all_text
        loc = None
    ext = os.path.splitext(path)[1].lstrip('.') or 'txt'
    result = {
        'charCount': len(content),
        'content': content,
        'filename': os.path.basename(path),
        'fileType': ext,
        'totalCharCount': total_chars,
        'totalLineCount': total_lines,
    }
    if loc:
        result['loc'] = loc
    print(json.dumps(result))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`,
  );
}

function writeLocalFile(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
  return runPyTool(
    params,
    `
try:
    path = params['path']
    content = params.get('content', '')
    if params.get('createDirectories'):
        parent = os.path.dirname(os.path.abspath(path))
        if parent:
            os.makedirs(parent, exist_ok=True)
    data = content.encode('utf-8')
    with open(path, 'wb') as f:
        f.write(data)
    print(json.dumps({'bytesWritten': len(data)}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`,
  );
}

function editLocalFile(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
  return runPyTool(
    params,
    `
try:
    import difflib
    path = params['path']
    search = params['search']
    replace = params['replace']
    replace_all = params.get('all', False)
    with open(path, 'r', errors='replace') as f:
        original = f.read()
    if not search:
        print(json.dumps({'error': 'search string must not be empty'}))
        sys.exit(0)
    if replace_all:
        new_content = original.replace(search, replace)
        replacements = original.count(search)
    elif search in original:
        new_content = original.replace(search, replace, 1)
        replacements = 1
    else:
        new_content = original
        replacements = 0
    with open(path, 'w') as f:
        f.write(new_content)
    orig_lines = original.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)
    diff = list(difflib.unified_diff(orig_lines, new_lines, lineterm=''))
    added = sum(1 for l in diff if l.startswith('+') and not l.startswith('+++'))
    deleted = sum(1 for l in diff if l.startswith('-') and not l.startswith('---'))
    print(json.dumps({
        'diffText': ''.join(diff)[:4096],
        'linesAdded': added,
        'linesDeleted': deleted,
        'replacements': replacements,
    }))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`,
  );
}

function searchLocalFiles(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
  return runPyTool(
    params,
    `
try:
    import datetime
    directory = params['directory']
    keyword = params.get('keywords') or params.get('keyword')
    raw_ft = params.get('fileType') or (params.get('fileTypes', [None])[0] if isinstance(params.get('fileTypes'), list) else None)
    file_type = str(raw_ft).lstrip('.') if raw_ft else None
    modified_after = params.get('modifiedAfter')
    modified_before = params.get('modifiedBefore')
    limit = int(params.get('limit', 500))
    results = []
    for root, dirs, files in os.walk(directory):
        for name in dirs + files:
            if keyword and keyword.lower() not in name.lower():
                continue
            if file_type and not name.endswith('.' + file_type):
                continue
            full_path = os.path.join(root, name)
            try:
                s = os.stat(full_path)
            except OSError:
                continue
            mt = datetime.datetime.fromtimestamp(s.st_mtime, tz=datetime.timezone.utc).isoformat()
            if modified_after and mt < str(modified_after):
                continue
            if modified_before and mt > str(modified_before):
                continue
            results.append({
                'isDirectory': os.path.isdir(full_path),
                'modifiedAt': mt,
                'name': name,
                'path': full_path,
                'size': s.st_size if not os.path.isdir(full_path) else None,
            })
            if len(results) >= limit:
                break
        if len(results) >= limit:
            break
    print(json.dumps({'results': results, 'totalCount': len(results)}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`,
  );
}

function moveLocalFiles(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
  return runPyTool(
    params,
    `
try:
    import shutil
    operations = params.get('operations', [])
    results = []
    for op in operations:
        src = op['source']
        dst = op['destination']
        try:
            parent = os.path.dirname(os.path.abspath(dst))
            if parent:
                os.makedirs(parent, exist_ok=True)
            shutil.move(src, dst)
            results.append({'destination': dst, 'source': src, 'success': True})
        except Exception as e:
            results.append({'destination': dst, 'error': str(e), 'source': src, 'success': False})
    success_count = sum(1 for r in results if r['success'])
    print(json.dumps({'results': results, 'successCount': success_count}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`,
  );
}

function renameLocalFile(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
  return runPyTool(
    params,
    `
try:
    import shutil
    old_path = params['oldPath']
    new_name = params['newName']
    parent = os.path.dirname(os.path.abspath(old_path))
    new_path = os.path.join(parent, new_name)
    shutil.move(old_path, new_path)
    print(json.dumps({'newPath': new_path}))
except Exception as e:
    print(json.dumps({'error': str(e), 'newPath': ''}))
`,
  );
}

function globLocalFiles(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
  return runPyTool(
    params,
    `
try:
    import glob as _glob
    pattern = params['pattern']
    directory = params.get('directory')
    if directory:
        original_cwd = os.getcwd()
        try:
            os.chdir(directory)
            matches = _glob.glob(pattern, recursive=True)
        finally:
            os.chdir(original_cwd)
    else:
        matches = _glob.glob(pattern, recursive=True)
    print(json.dumps({'files': matches, 'totalCount': len(matches)}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`,
  );
}

function grepContent(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
  return runPyTool(
    params,
    `
try:
    import subprocess as _sp
    pattern = params['pattern']
    directory = params['directory']
    file_pattern = params.get('filePattern', '*')
    recursive = params.get('recursive', True)
    args = ['grep', '-n', '--include', str(file_pattern), '-P']
    if recursive:
        args.append('-r')
    args.extend([str(pattern), str(directory)])
    result = _sp.run(args, capture_output=True, text=True, timeout=30)
    matches = []
    for line in result.stdout.splitlines():
        parts = line.split(':', 2)
        if len(parts) == 3:
            matches.append({
                'content': parts[2],
                'lineNumber': int(parts[1]) if parts[1].isdigit() else None,
                'path': parts[0],
            })
        elif line:
            matches.append({'content': line, 'path': directory})
    print(json.dumps({'matches': matches, 'totalMatches': len(matches)}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`,
  );
}

function executeCode(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
  return runPyTool(
    params,
    `
try:
    import subprocess as _sp, tempfile
    lang = str(params.get('language', 'python')).lower()
    code = params.get('code', '')
    timeout_s = min(float(params.get('timeout', 30000)) / 1000, 120)
    ext_map = {'javascript': '.mjs', 'python': '.py', 'typescript': '.ts'}
    ext = ext_map.get(lang, '.py')
    with tempfile.NamedTemporaryFile(mode='w', suffix=ext, delete=False) as f:
        f.write(str(code))
        fname = f.name
    runner_map = {
        'javascript': ['node', fname],
        'python': ['python3', '-u', fname],
        'typescript': ['npx', '--yes', 'tsx', fname],
    }
    runner = runner_map.get(lang, ['python3', '-u', fname])
    try:
        r = _sp.run(runner, capture_output=True, text=True, timeout=timeout_s)
        print(json.dumps({
            'exitCode': r.returncode,
            'output': r.stdout,
            'stderr': r.stderr,
        }))
    except _sp.TimeoutExpired:
        print(json.dumps({
            'error': f'Execution timed out after {timeout_s:.0f}s',
            'exitCode': 124,
            'output': '',
            'stderr': f'Timeout: exceeded {timeout_s:.0f}s',
        }))
    finally:
        try:
            os.unlink(fname)
        except Exception:
            pass
except Exception as e:
    print(json.dumps({'error': str(e), 'exitCode': 1, 'output': '', 'stderr': str(e)}))
`,
  );
}

async function runCommand(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
  const isBackground = Boolean(params.background);
  const command = String(params.command || '');
  const timeoutMs = typeof params.timeout === 'number' ? params.timeout : 120_000;
  const timeoutS = Math.min(Math.ceil(timeoutMs / 1000), 300);

  log('runCommand: background=%s cmd=%s', isBackground, command.slice(0, 200));

  if (isBackground) {
    const commandId = crypto.randomUUID();
    const dir = `/tmp/lh-sbx-${commandId}`;
    // Write command to a file to avoid all quoting issues.
    // Use `setsid` (not `nohup`) so the background process starts in its own
    // session and process group — this makes killpg(getpgid(pid), SIGTERM) safe
    // and precise. nohup does not create a new process group, so getpgid would
    // return the parent shell's PGID and kill unrelated processes.
    const cmdB64 = Buffer.from(command).toString('base64');
    const shellCmd = [
      `mkdir -p ${dir}`,
      `echo ${cmdB64} | base64 -d >${dir}/cmd.sh`,
      `chmod +x ${dir}/cmd.sh`,
      // setsid gives the process its own session; redirect and background it
      `(cd ${getWorkdir()} && setsid ${dir}/cmd.sh >${dir}/log 2>&1 & echo $! >${dir}/pid && printf '0' >${dir}/offset)`,
      `echo '{"commandId":"${commandId}"}'`,
    ].join(' && ');

    try {
      const { exitCode, stderr, stdout } = await cloudSandboxSshRun(shellCmd);
      if (exitCode !== 0)
        return fail(stderr || `Failed to start background command (exit ${exitCode})`);
      const result = JSON.parse(stdout.trim()) as Record<string, unknown>;
      return ok(result);
    } catch (err) {
      return fail((err as Error).message);
    }
  }

  // Foreground: run via Python subprocess for clean capture + timeout
  return runPyTool(
    params,
    `
try:
    import subprocess as _sp
    cmd = params['command']
    timeout_s = ${timeoutS}
    r = _sp.run(['bash', '-c', str(cmd)], capture_output=True, text=True, timeout=timeout_s)
    print(json.dumps({
        'exitCode': r.returncode,
        'output': r.stdout,
        'stderr': r.stderr,
        'stdout': r.stdout,
    }))
except _sp.TimeoutExpired:
    print(json.dumps({
        'error': f'Command timed out after ${timeoutS}s',
        'exitCode': 124,
        'output': '',
        'stderr': 'Timeout',
        'stdout': '',
    }))
except Exception as e:
    print(json.dumps({'error': str(e), 'exitCode': 1, 'output': '', 'stderr': str(e), 'stdout': ''}))
`,
  );
}

function getCommandOutput(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
  return runPyTool(
    params,
    `
try:
    cid = params['commandId']
    d = f'/tmp/lh-sbx-{cid}'
    offset_file = f'{d}/offset'
    log_file = f'{d}/log'
    pid_file = f'{d}/pid'
    if not os.path.exists(d):
        print(json.dumps({'error': f'Unknown commandId: {cid}', 'newOutput': '', 'running': False}))
        sys.exit(0)
    # Read offset
    try:
        with open(offset_file) as f:
            offset = int(f.read().strip() or '0')
    except Exception:
        offset = 0
    # Read new output since last offset
    try:
        with open(log_file, 'rb') as f:
            f.seek(offset)
            new_bytes = f.read()
        new_output = new_bytes.decode('utf-8', errors='replace')
        new_offset = offset + len(new_bytes)
    except Exception:
        new_output = ''
        new_offset = offset
    # Update offset atomically
    try:
        with open(offset_file, 'w') as f:
            f.write(str(new_offset))
    except Exception:
        pass
    # Check if process is still running
    running = False
    try:
        pid = int(open(pid_file).read().strip())
        os.kill(pid, 0)  # does not send signal, just checks existence
        running = True
    except (ProcessLookupError, ValueError, FileNotFoundError, PermissionError):
        running = False
    # Auto-cleanup: when the process has finished and all output has been
    # drained, remove the temp dir so /tmp does not accumulate stale entries.
    if not running and not new_output:
        try:
            import shutil as _shutil
            _shutil.rmtree(d, ignore_errors=True)
        except Exception:
            pass
    print(json.dumps({'newOutput': new_output, 'running': running}))
except Exception as e:
    print(json.dumps({'error': str(e), 'newOutput': '', 'running': False}))
`,
  );
}

function killCommand(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
  return runPyTool(
    params,
    `
try:
    import signal
    cid = params['commandId']
    pid_file = f'/tmp/lh-sbx-{cid}/pid'
    if not os.path.exists(pid_file):
        print(json.dumps({'error': f'Unknown commandId: {cid}'}))
        sys.exit(0)
    pid = int(open(pid_file).read().strip())
    try:
        # setsid ensures the background process has its own session/PGID,
        # so killpg is safe and only affects that command's process tree.
        pgid = os.getpgid(pid)
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        pass  # already dead, that's fine
    except Exception:
        # Fallback: kill just the pid
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    # Cleanup temp dir immediately after explicit kill
    try:
        import shutil as _shutil
        _shutil.rmtree(f'/tmp/lh-sbx-{cid}', ignore_errors=True)
    except Exception:
        pass
    print(json.dumps({}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`,
  );
}

// ──────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────

/**
 * Dispatch map for all supported SSH tools.
 * `CLOUD_SANDBOX_SSH_TOOL_NAMES` is derived from this map's keys, so adding a
 * new tool only requires one change here — the Set and the dispatch stay in sync
 * automatically.
 */
const toolHandlers: Record<
  string,
  (params: Record<string, unknown>) => Promise<SandboxCallToolResult>
> = {
  editLocalFile,
  executeCode,
  getCommandOutput,
  globLocalFiles,
  grepContent,
  killCommand,
  listLocalFiles,
  moveLocalFiles,
  readLocalFile,
  renameLocalFile,
  runCommand,
  searchLocalFiles,
  writeLocalFile,
};

/**
 * The exact set of toolNames this SSH executor handles.
 * Derived from `toolHandlers` — stays in sync automatically.
 */
export const CLOUD_SANDBOX_SSH_TOOL_NAMES = new Set(Object.keys(toolHandlers));

/**
 * Route a CloudSandbox tool call through SSH to the configured VPS.
 * Only call this when isCloudSandboxSshConfigured() is true and
 * CLOUD_SANDBOX_SSH_TOOL_NAMES.has(toolName) is true.
 */
export async function runCloudSandboxToolViaSsh(
  toolName: string,
  params: Record<string, unknown>,
): Promise<SandboxCallToolResult> {
  log('runCloudSandboxToolViaSsh: tool=%s', toolName);
  const handler = toolHandlers[toolName];
  if (!handler) {
    log('runCloudSandboxToolViaSsh: unknown tool %s', toolName);
    return fail(`SSH executor does not support tool: ${toolName}`);
  }
  return handler(params);
}

/**
 * Read a file from the VPS sandbox via SSH.
 * Returns the raw Buffer of the file for S3 upload.
 * Throws if the file does not exist or SSH fails.
 *
 * The file path is embedded as a base64 blob inside a Python script — the same
 * injection-safe pattern used by all 13 structured tools — so arbitrary filePath
 * values (including those containing $(), backticks, or shell metacharacters)
 * cannot be executed by the shell.
 */
export async function exportFileViaSsh(filePath: string): Promise<Buffer> {
  log('exportFileViaSsh: path=%s', filePath);
  const pathB64 = Buffer.from(filePath).toString('base64');
  const script = [
    'import base64, sys',
    `path = base64.b64decode('${pathB64}').decode('utf-8')`,
    'with open(path, "rb") as f:',
    '    data = f.read()',
    'print(base64.b64encode(data).decode("ascii"))',
  ].join('\n');
  const scriptB64 = Buffer.from(script).toString('base64');
  const { exitCode, stderr, stdout } = await cloudSandboxSshRun(
    `echo ${scriptB64} | base64 -d | python3`,
  );
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `Failed to read file from VPS: ${filePath}`);
  }
  return Buffer.from(stdout.trim(), 'base64');
}
