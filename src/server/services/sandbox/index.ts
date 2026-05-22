import {
  type ISandboxService,
  type SandboxCallToolResult,
  type SandboxExportFileResult,
} from '@lobechat/builtin-tool-cloud-sandbox';
import { type CodeInterpreterToolName } from '@lobehub/market-sdk';
import debug from 'debug';
import { sha256 } from 'js-sha256';
import mime from 'mime';

import { FileS3 } from '@/server/modules/S3';
import { type FileService } from '@/server/services/file';
import { type MarketService } from '@/server/services/market';
import {
  CLOUD_SANDBOX_SSH_TOOL_NAMES,
  exportFileViaSsh,
  runCloudSandboxToolViaSsh,
} from '@/server/utils/cloudSandboxSshExecutor';
import { isCloudSandboxSshConfigured } from '@/server/utils/cloudSandboxSshRunner';

const log = debug('lobe-server:sandbox-service');

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
   * Call a sandbox tool.
   * When SSH is configured, all CloudSandbox builtin tools are routed to the
   * VPS via SSH — no Market authorization required. Other tools (e.g. execScript)
   * fall through to the Market SDK path.
   */
  async callTool(toolName: string, params: Record<string, any>): Promise<SandboxCallToolResult> {
    const useSsh = isCloudSandboxSshConfigured() && CLOUD_SANDBOX_SSH_TOOL_NAMES.has(toolName);
    log(
      'callTool: toolName=%s topicId=%s path=%s',
      toolName,
      this.topicId,
      useSsh ? 'ssh' : 'market',
    );

    if (useSsh) {
      return runCloudSandboxToolViaSsh(toolName, params as Record<string, unknown>);
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
   * Export a file from sandbox and upload to S3, then create a persistent file record.
   * When SSH is configured, reads the file from the VPS directly and uploads server-side.
   * Otherwise delegates to the Market sandbox exportFile tool.
   */
  async exportAndUploadFile(path: string, filename: string): Promise<SandboxExportFileResult> {
    log('Exporting file: %s from path: %s, topicId: %s', filename, path, this.topicId);

    try {
      const s3 = new FileS3();
      const today = new Date().toISOString().split('T')[0];
      const key = `code-interpreter-exports/${today}/${this.topicId}/${filename}`;

      let mimeType: string;
      let fileSize: number | undefined;

      if (isCloudSandboxSshConfigured()) {
        // SSH path: read file from VPS, upload to S3 server-side
        log('exportAndUploadFile: SSH path for %s', path);
        const fileBuffer = await exportFileViaSsh(path);
        fileSize = fileBuffer.length;
        mimeType = mime.getType(filename) || 'application/octet-stream';
        await s3.uploadMedia(key, fileBuffer);
        log('exportAndUploadFile: uploaded %d bytes to %s', fileSize, key);
      } else {
        // Market path: give sandbox a pre-signed URL and have it upload
        const uploadUrl = await s3.createPreSignedUrl(key);
        log('Generated upload URL for key: %s', key);

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
        if (result?.success === false) {
          return {
            error: { message: result?.error || 'Failed to upload file from sandbox' },
            filename,
            success: false,
          };
        }

        const metadata = await s3.getFileMetadata(key);
        fileSize = metadata.contentLength;
        mimeType = metadata.contentType || result?.mimeType || 'application/octet-stream';
      }

      // Both paths converge here to create the persistent file record
      const fileHash = sha256(key + Date.now().toString());

      const { fileId, url } = await this.fileService.createFileRecord({
        fileHash,
        fileType: mimeType,
        name: filename,
        size: fileSize,
        url: key,
      });

      log('Created file record: fileId=%s, url=%s', fileId, url);

      return {
        fileId,
        filename,
        mimeType,
        size: fileSize,
        success: true,
        url,
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
