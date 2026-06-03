import debug from 'debug';
import { Client as SshClient } from 'ssh2';

import { appEnv } from '@/envs/app';

const log = debug('lobe-server:cloud-sandbox-ssh');

export interface CloudSandboxSshRunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

function decodePrivateKey(base64Key: string): string {
  return Buffer.from(base64Key, 'base64').toString('utf-8');
}

function executeRemoteCommand(conn: SshClient, command: string): Promise<CloudSandboxSshRunResult> {
  return new Promise((resolve, reject) => {
    conn.exec(
      command,
      (err: Error | undefined, stream: NodeJS.EventEmitter & { stderr: NodeJS.EventEmitter }) => {
        if (err) {
          log('exec error %s', err.message);
          conn.end();
          return reject(err);
        }
        let stdout = '';
        let stderr = '';
        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        stream.on('close', (exitCode: number) => {
          log(
            'done exitCode=%d stdout=%s stderr=%s',
            exitCode,
            stdout.slice(0, 200),
            stderr.slice(0, 200),
          );
          conn.end();
          resolve({ exitCode, stderr, stdout });
        });
      },
    );
  });
}

/** Returns true when all three required SSH env vars are set. */
export function isCloudSandboxSshConfigured(): boolean {
  const { CLOUD_SANDBOX_SSH_HOST, CLOUD_SANDBOX_SSH_USER, CLOUD_SANDBOX_SSH_PRIVATE_KEY_BASE64 } =
    appEnv;
  return !!(
    CLOUD_SANDBOX_SSH_HOST &&
    CLOUD_SANDBOX_SSH_USER &&
    CLOUD_SANDBOX_SSH_PRIVATE_KEY_BASE64
  );
}

/**
 * Run a shell command on the configured Cloud Sandbox VPS via SSH.
 * Connects using CLOUD_SANDBOX_SSH_* env vars, executes the command,
 * captures stdout/stderr, and resolves with the result.
 *
 * Throws if SSH connection or exec fails.
 * For fire-and-forget long-running processes, wrap the command with
 * `nohup bash -c '<cmd>' > /tmp/out.log 2>&1 &` before calling — the
 * stream closes immediately while the process keeps running on the VPS.
 */
export function cloudSandboxSshRun(command: string): Promise<CloudSandboxSshRunResult> {
  const {
    CLOUD_SANDBOX_SSH_HOST,
    CLOUD_SANDBOX_SSH_PORT,
    CLOUD_SANDBOX_SSH_USER,
    CLOUD_SANDBOX_SSH_PRIVATE_KEY_BASE64,
  } = appEnv;

  if (!CLOUD_SANDBOX_SSH_HOST || !CLOUD_SANDBOX_SSH_USER || !CLOUD_SANDBOX_SSH_PRIVATE_KEY_BASE64) {
    return Promise.reject(
      new Error(
        'SSH not configured (CLOUD_SANDBOX_SSH_HOST, CLOUD_SANDBOX_SSH_USER, CLOUD_SANDBOX_SSH_PRIVATE_KEY_BASE64)',
      ),
    );
  }

  const privateKey = decodePrivateKey(CLOUD_SANDBOX_SSH_PRIVATE_KEY_BASE64);
  log('host=%s command=%s', CLOUD_SANDBOX_SSH_HOST, command.slice(0, 300));

  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    conn.on('ready', () => {
      log('connected');
      executeRemoteCommand(conn, command).then(resolve).catch(reject);
    });
    conn.on('error', (err: Error) => {
      log('connection error %s', err.message);
      reject(err);
    });
    conn.connect({
      host: CLOUD_SANDBOX_SSH_HOST,
      port: CLOUD_SANDBOX_SSH_PORT ?? 22,
      privateKey,
      username: CLOUD_SANDBOX_SSH_USER,
    });
  });
}

/**
 * Dispatch a long-running agent command as a detached background process on the Cloud Sandbox VPS.
 * Uses nohup so the process survives SSH disconnect.
 * Logs to /tmp/lh-{operationId}.log on the remote host.
 * Resolves once the process is successfully spawned (not when it finishes).
 */
export async function cloudSandboxSshDispatch(
  shellCommand: string,
  operationId: string,
): Promise<void> {
  const logFile = `/tmp/lh-${operationId}.log`;
  const bgCommand = `nohup bash -c ${JSON.stringify(shellCommand)} > ${logFile} 2>&1 &`;
  log('dispatch op=%s', operationId);
  await cloudSandboxSshRun(bgCommand);
  log('dispatch done op=%s', operationId);
}
