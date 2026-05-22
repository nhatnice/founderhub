import {
  type ISandboxService,
  type SandboxCallToolResult,
  type SandboxExportFileResult,
} from '@lobechat/builtin-tool-cloud-sandbox';
import { type CodeInterpreterToolName } from '@lobehub/market-sdk';
import debug from 'debug';
import { sha256 } from 'js-sha256';
import { Client as SshClient } from 'ssh2';

import { appEnv } from '@/envs/app';
import { FileS3 } from '@/server/modules/S3';
import { type FileService } from '@/server/services/file';
import { type MarketService } from '@/server/services/market';

const log = debug('lobe-server:sandbox-service');

const isCommandTool = (name: string) =>
  name === 'runCommand' || name === 'execScript' || name === 'executeCode';

export interface ServerSandboxServiceOptions {
  fileService: FileService;
  marketService: MarketService;
  topicId: string;
  userId: string;
}

/**
 * Server-side Sandbox Service
 *
 * This service implements ISandboxService for server-side execution.
 * Context (topicId, userId) is bound at construction time.
 * It uses MarketService to call sandbox tools.
 *
 * Usage:
 * - Used by BuiltinToolsExecutor when executing CloudSandbox tools on server
 * - MarketService handles authentication via trustedClientToken
 */
export class ServerSandboxService implements ISandboxService {
  private fileService: FileService;
  private marketService: MarketService;
  private topicId: string;
  private userId: string;

  constructor(options: ServerSandboxServiceOptions) {
    this.fileService = options.fileService;
    this.marketService = options.marketService;
    this.topicId = options.topicId;
    this.userId = options.userId;
  }

  /**
   * Call a sandbox tool via MarketService
   */
  async callTool(toolName: string, params: Record<string, any>): Promise<SandboxCallToolResult> {
    const path = appEnv.CLOUD_SANDBOX_SSH_HOST && isCommandTool(toolName) ? 'ssh' : 'market';
    log('callTool: toolName=%s topicId=%s path=%s', toolName, this.topicId, path);

    if (path === 'ssh') {
      return this.sshCallTool(toolName, params);
    }

    log('Calling sandbox tool: %s with params: %O, topicId: %s', toolName, params, this.topicId);

    try {
      const response = await this.marketService
        .getSDK()
        .plugins.runBuildInTool(toolName as CodeInterpreterToolName, params as any, {
          topicId: this.topicId,
          userId: this.userId,
        });

      log('Sandbox tool %s response: %O', toolName, response);

      if (!response.success) {
        return {
          error: {
            message: response.error?.message || 'Unknown error',
            name: response.error?.code,
          },
          result: null,
          sessionExpiredAndRecreated: false,
          success: false,
        };
      }

      return {
        result: response.data?.result,
        sessionExpiredAndRecreated: response.data?.sessionExpiredAndRecreated || false,
        success: true,
      };
    } catch (error) {
      log('Error calling sandbox tool %s: %O', toolName, error);

      return {
        error: {
          message: (error as Error).message,
          name: (error as Error).name,
        },
        result: null,
        sessionExpiredAndRecreated: false,
        success: false,
      };
    }
  }

  /**
   * Execute a command tool synchronously via SSH on the configured VPS.
   * Unlike spawnHeteroSandbox (fire-and-forget), this captures stdout/stderr
   * and resolves immediately so the LLM receives the tool result.
   */
  private sshCallTool(
    toolName: string,
    params: Record<string, any>,
  ): Promise<SandboxCallToolResult> {
    return new Promise((resolve) => {
      const {
        CLOUD_SANDBOX_SSH_HOST,
        CLOUD_SANDBOX_SSH_PORT,
        CLOUD_SANDBOX_SSH_USER,
        CLOUD_SANDBOX_SSH_PRIVATE_KEY_BASE64,
      } = appEnv;

      if (
        !CLOUD_SANDBOX_SSH_HOST ||
        !CLOUD_SANDBOX_SSH_USER ||
        !CLOUD_SANDBOX_SSH_PRIVATE_KEY_BASE64
      ) {
        return resolve({
          error: { message: 'SSH not configured', name: 'ConfigError' },
          result: null,
          sessionExpiredAndRecreated: false,
          success: false,
        });
      }

      const privateKey = Buffer.from(CLOUD_SANDBOX_SSH_PRIVATE_KEY_BASE64, 'base64').toString(
        'utf-8',
      );

      let shellCommand: string;
      if (toolName === 'runCommand') {
        shellCommand = params.command as string;
      } else {
        // execScript / executeCode
        const lang = (params.language as string) || 'python3';
        shellCommand = `${lang} -c ${JSON.stringify(params.code as string)}`;
      }

      log(
        'sshCallTool: toolName=%s host=%s command=%s',
        toolName,
        CLOUD_SANDBOX_SSH_HOST,
        shellCommand,
      );

      const conn = new SshClient();
      conn.on('ready', () => {
        conn.exec(
          shellCommand,
          (
            err: Error | undefined,
            stream: NodeJS.EventEmitter & { stderr: NodeJS.EventEmitter },
          ) => {
            if (err) {
              log('sshCallTool error (exec): %s', err.message);
              conn.end();
              return resolve({
                error: { message: err.message, name: err.name },
                result: null,
                sessionExpiredAndRecreated: false,
                success: false,
              });
            }
            let stdout = '';
            let stderr = '';
            stream.on('data', (data: Buffer) => {
              stdout += data.toString();
            });
            stream.stderr.on('data', (data: Buffer) => {
              stderr += data.toString();
            });
            stream.on('close', (code: number) => {
              log(
                'sshCallTool result: exitCode=%d stdout=%s stderr=%s',
                code,
                stdout.slice(0, 200),
                stderr.slice(0, 200),
              );
              conn.end();
              resolve({
                result: { exitCode: code, output: stdout, stderr },
                sessionExpiredAndRecreated: false,
                success: code === 0,
                ...(code !== 0
                  ? { error: { message: stderr || `Exit code ${code}`, name: 'ExecError' } }
                  : {}),
              });
            });
          },
        );
      });
      conn.on('error', (err: Error) => {
        log('sshCallTool error (connection): %s', err.message);
        resolve({
          error: { message: err.message, name: err.name },
          result: null,
          sessionExpiredAndRecreated: false,
          success: false,
        });
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
   * Export and upload a file from sandbox to S3
   *
   * Steps:
   * 1. Generate S3 pre-signed upload URL
   * 2. Call sandbox exportFile tool to upload file
   * 3. Verify upload success and get metadata
   * 4. Create persistent file record
   */
  async exportAndUploadFile(path: string, filename: string): Promise<SandboxExportFileResult> {
    log('Exporting file: %s from path: %s, topicId: %s', filename, path, this.topicId);

    try {
      const s3 = new FileS3();

      // Use date-based sharding for privacy compliance (GDPR, CCPA)
      const today = new Date().toISOString().split('T')[0];

      // Generate a unique key for the exported file
      const key = `code-interpreter-exports/${today}/${this.topicId}/${filename}`;

      // Step 1: Generate pre-signed upload URL
      const uploadUrl = await s3.createPreSignedUrl(key);
      log('Generated upload URL for key: %s', key);

      // Step 2: Call sandbox's exportFile tool with the upload URL
      const response = await this.marketService.exportFile({
        path,
        topicId: this.topicId,
        uploadUrl,
        userId: this.userId,
      });

      log('Sandbox exportFile response: %O', response);

      if (!response.success) {
        return {
          error: { message: response.error?.message || 'Failed to export file from sandbox' },
          filename,
          success: false,
        };
      }

      const result = response.data?.result;
      const uploadSuccess = result?.success !== false;

      if (!uploadSuccess) {
        return {
          error: { message: result?.error || 'Failed to upload file from sandbox' },
          filename,
          success: false,
        };
      }

      // Step 3: Get file metadata from S3 to verify upload and get actual size
      const metadata = await s3.getFileMetadata(key);
      const fileSize = metadata.contentLength;
      const mimeType = metadata.contentType || result?.mimeType || 'application/octet-stream';

      // Step 4: Create persistent file record using FileService
      // Generate a simple hash from the key (since we don't have the actual file content)
      const fileHash = sha256(key + Date.now().toString());

      const { fileId, url } = await this.fileService.createFileRecord({
        fileHash,
        fileType: mimeType,
        name: filename,
        size: fileSize,
        url: key, // Store S3 key
      });

      log('Created file record: fileId=%s, url=%s', fileId, url);

      return {
        fileId,
        filename,
        mimeType,
        size: fileSize,
        success: true,
        url, // This is the permanent /f/:id URL
      };
    } catch (error) {
      log('Error exporting file: %O', error);

      return {
        error: { message: (error as Error).message },
        filename,
        success: false,
      };
    }
  }
}
