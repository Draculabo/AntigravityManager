import multipart from '@fastify/multipart';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, vi } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { ClientFilesController } from '@/modules/proxy-gateway/server/modules/files/client-files.controller';
import { GeminiFilesController } from '@/modules/proxy-gateway/server/modules/files/gemini-files.controller';
import { FilesService } from '@/modules/proxy-gateway/server/modules/files/files.service';
import { DEFAULT_MAX_FILE_BYTES } from '@/modules/proxy-gateway/server/modules/files/file-store.types';
import { OpenAIUploadsController } from '@/modules/proxy-gateway/server/modules/uploads/openai-uploads.controller';
import { OpenAIUploadsService } from '@/modules/proxy-gateway/server/modules/uploads/openai-uploads.service';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));

export type FilesHttpOperations = Pick<
  FilesService,
  'create' | 'list' | 'stat' | 'content' | 'remove'
>;
export type UploadsHttpOperations = Pick<
  OpenAIUploadsService,
  'create' | 'addPart' | 'complete' | 'cancel'
>;
export const filesTestHeaders = { authorization: 'Bearer synthetic-files-key' };
const apps: NestFastifyApplication[] = [];
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  setServerConfig(previous);
});

/** Uses production controllers and the same multipart/raw-media parser setup as gateway boot. */
export async function createFilesHttpApp(
  files: FilesHttpOperations,
  uploads?: UploadsHttpOperations,
): Promise<NestFastifyApplication> {
  @Module({
    controllers: [
      ClientFilesController,
      GeminiFilesController,
      ...(uploads ? [OpenAIUploadsController] : []),
    ],
    providers: [
      ProxyGuard,
      { provide: FilesService, useValue: files },
      ...(uploads ? [{ provide: OpenAIUploadsService, useValue: uploads }] : []),
    ],
  })
  class FilesHttpTestModule {}

  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: 'synthetic-files-key' });
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(FilesHttpTestModule, adapter, {
    logger: false,
  });
  apps.push(app);
  await app.register(multipart, { limits: { files: 16, fileSize: 100 * 1024 * 1024, fields: 32 } });
  adapter
    .getInstance()
    .addContentTypeParser(
      /^(?:application|audio|font|image|model|text|video)\//u,
      { bodyLimit: DEFAULT_MAX_FILE_BYTES + 1024 * 1024, parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
  await app.init();
  return app;
}

export interface MultipartFile {
  bytes: Buffer;
  filename: string;
  mimeType: string;
}

/** Encodes actual multipart bytes so parser and handler failures share the HTTP execution path. */
export function fileMultipartPayload(
  fields: Array<[string, string]>,
  file: MultipartFile | null,
  fieldName = 'file',
) {
  const boundary = '----agmfiles';
  const chunks: Buffer[] = fields.map(([name, value]) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ),
  );
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      ),
      file.bytes,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: { ...filesTestHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  };
}
