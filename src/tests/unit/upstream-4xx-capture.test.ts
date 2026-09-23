import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom, of } from 'rxjs';
import {
  getUpstreamCaptureContext,
  runWithUpstreamCaptureContext,
  snapshotCapturePayload,
  type UpstreamCaptureContext,
  UpstreamCaptureContextInterceptor,
} from '@/modules/proxy-gateway/server/common/upstream-capture-context';
import { Upstream4xxCaptureService } from '@/modules/proxy-gateway/server/common/upstream-4xx-capture.service';

let agentDirectory = '';

vi.mock('@/shared/platform/paths', () => ({
  getAgentDir: vi.fn(() => agentDirectory),
}));

const CAPTURES_DIRECTORY = 'captures';
const CAPTURE_LIMIT = 50;
const CAPTURE_DIRECTORY_MAX_BYTES_ENV = 'AGM_UPSTREAM_4XX_CAPTURE_MAX_DIRECTORY_BYTES';

function captureContext(
  overrides: Partial<UpstreamCaptureContext['clientRequest']> = {},
): UpstreamCaptureContext {
  return {
    clientRequest: {
      body: { model: 'client-model', input: 'client request' },
      endpoint: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      ...overrides,
    },
  };
}

async function writeCapture(
  input: Partial<Parameters<InstanceType<typeof Upstream4xxCaptureService>['capture']>[0]> = {},
) {
  const capture = new Upstream4xxCaptureService();
  await runWithUpstreamCaptureContext(captureContext(), () =>
    capture.capture({
      endpoint: 'https://cloudcode-pa.googleapis.com/v1internal:generateContent',
      status: 400,
      upstreamErrorBody: { error: { message: 'rejected' } },
      upstreamRequest: { request: { model: 'upstream-model' } },
      ...input,
    }),
  );
}

async function captureFiles(): Promise<string[]> {
  const directory = path.join(agentDirectory, CAPTURES_DIRECTORY);
  try {
    return await fs.readdir(directory);
  } catch {
    return [];
  }
}

async function captureDirectoryBytes(): Promise<number> {
  const directory = path.join(agentDirectory, CAPTURES_DIRECTORY);
  const files = (await captureFiles()).filter((file) => file.endsWith('.json'));
  const sizes = await Promise.all(
    files.map(async (file) => (await fs.stat(path.join(directory, file))).size),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

describe('upstream 4xx capture', () => {
  beforeEach(async () => {
    agentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-upstream-capture-'));
    process.env.AGM_UPSTREAM_4XX_CAPTURE = '1';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.AGM_UPSTREAM_4XX_CAPTURE;
    delete process.env[CAPTURE_DIRECTORY_MAX_BYTES_ENV];
    await fs.rm(agentDirectory, { force: true, recursive: true });
  });

  it('writes one JSON file with the client request, upstream payload, and upstream response', async () => {
    await writeCapture();

    const files = await captureFiles();
    expect(files).toHaveLength(1);

    const document = JSON.parse(
      await fs.readFile(path.join(agentDirectory, CAPTURES_DIRECTORY, files[0]), 'utf-8'),
    ) as Record<string, unknown>;
    expect(document.client_request).toEqual(expect.any(Object));
    expect(document.upstream_request).toEqual(expect.any(Object));
    expect(document.upstream_response).toEqual(expect.any(Object));
    expect(document.metadata).toMatchObject({
      client_visible_model: 'client-model',
      mapped_upstream_model: 'upstream-model',
    });
  });

  it('preserves a capture when the client model path has malformed percent encoding', async () => {
    const capture = new Upstream4xxCaptureService();
    await runWithUpstreamCaptureContext(
      captureContext({ body: {}, endpoint: '/v1beta/models/bad%ZZ:generateContent' }),
      () =>
        capture.capture({
          endpoint: 'https://cloudcode-pa.googleapis.com/v1internal:generateContent',
          status: 400,
          upstreamErrorBody: { error: { message: 'rejected' } },
          upstreamRequest: { request: { model: 'upstream-model' } },
        }),
    );

    const files = await captureFiles();
    expect(files).toHaveLength(1);
    const document = JSON.parse(
      await fs.readFile(path.join(agentDirectory, CAPTURES_DIRECTORY, files[0]), 'utf-8'),
    ) as { metadata?: { client_visible_model?: string } };
    expect(document.metadata?.client_visible_model).toBe('bad%ZZ');
  });

  it('does not write a capture for a 2xx response', async () => {
    await writeCapture({ status: 200 });

    expect(await captureFiles()).toEqual([]);
  });

  it('does not write a capture when the flag is disabled', async () => {
    delete process.env.AGM_UPSTREAM_4XX_CAPTURE;

    await writeCapture();

    expect(await captureFiles()).toEqual([]);
  });

  it('does not inspect or snapshot the request when capture is disabled', async () => {
    delete process.env.AGM_UPSTREAM_4XX_CAPTURE;
    const switchToHttp = vi.fn();
    const next = { handle: vi.fn(() => of('ok')) };
    const interceptor = new UpstreamCaptureContextInterceptor();

    await firstValueFrom(interceptor.intercept({ switchToHttp } as never, next as never));

    expect(switchToHttp).not.toHaveBeenCalled();
    expect(next.handle).toHaveBeenCalledOnce();
  });

  it('keeps only diagnostic allowlisted headers in the capture context', async () => {
    const interceptor = new UpstreamCaptureContextInterceptor();
    let capturedHeaders: Record<string, unknown> | undefined;
    const next = {
      handle: () => {
        capturedHeaders = getUpstreamCaptureContext()?.clientRequest.headers;
        return of('ok');
      },
    };
    const request = {
      body: {},
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
        'x-debug-context': 'private metadata',
      },
      url: '/v1/chat/completions',
    };

    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    };
    await firstValueFrom(interceptor.intercept(context as never, next as never));

    expect(capturedHeaders).toEqual({ 'content-type': 'application/json' });
  });

  it('bounds and redacts direct sensitive fields in the request capture context', async () => {
    const interceptor = new UpstreamCaptureContextInterceptor();
    let capturedBody: unknown;
    const next = {
      handle: () => {
        capturedBody = getUpstreamCaptureContext()?.clientRequest.body;
        return of('ok');
      },
    };
    const secret = 'snapshot-secret';
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          body: { api_key: secret, input: 'x'.repeat(512 * 1024) },
          headers: {},
          url: '/v1/chat/completions',
        }),
      }),
    };

    await firstValueFrom(interceptor.intercept(context as never, next as never));

    const serialized = JSON.stringify(capturedBody);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[truncated]');
    expect(Buffer.byteLength(serialized, 'utf-8')).toBeLessThan(300 * 1024);
  });

  it('caps an escaped diagnostic payload snapshot at 256 KiB', () => {
    const snapshot = snapshotCapturePayload({ input: '\u0000'.repeat(256 * 1024) });
    const serialized = JSON.stringify(snapshot);

    expect(Buffer.byteLength(serialized, 'utf-8')).toBeLessThanOrEqual(256 * 1024);
    expect(snapshot).toMatchObject({
      capture_truncated: true,
      max_snapshot_size_bytes: 256 * 1024,
    });
  });

  it('redacts secrets in client headers and both request bodies', async () => {
    const secret = 'do-not-write-this-secret';
    const capture = new Upstream4xxCaptureService();
    await runWithUpstreamCaptureContext(
      captureContext({
        body: { api_key: secret, nested: { access_token: secret } },
        headers: {
          Authorization: `Bearer ${secret}`,
          Cookie: `session=${secret}`,
          'x-api-key': secret,
          'x-goog-api-key': secret,
        },
      }),
      () =>
        capture.capture({
          endpoint: 'https://cloudcode-pa.googleapis.com/v1internal:generateContent',
          status: 400,
          upstreamErrorBody: { error: { refresh_token: secret } },
          upstreamRequest: { request: { api_key: secret } },
        }),
    );

    const [file] = await captureFiles();
    const content = await fs.readFile(path.join(agentDirectory, CAPTURES_DIRECTORY, file), 'utf-8');
    expect(content).not.toContain(secret);
  });

  it('never persists short image Base64 from client or upstream requests', async () => {
    const dataUrl = 'data:image/webp;name=source;BASE64,AQ==';
    const capture = new Upstream4xxCaptureService();
    await runWithUpstreamCaptureContext(captureContext({ body: { image: dataUrl } }), () =>
      capture.capture({
        endpoint: 'https://cloudcode-pa.googleapis.com/v1internal:generateContent',
        status: 400,
        upstreamErrorBody: { error: { message: 'rejected' } },
        upstreamRequest: {
          request: {
            contents: [{ parts: [{ inlineData: { data: 'AQ==', mimeType: 'image/webp' } }] }],
          },
        },
      }),
    );

    const [file] = await captureFiles();
    const content = await fs.readFile(path.join(agentDirectory, CAPTURES_DIRECTORY, file), 'utf-8');
    expect(content).not.toContain(dataUrl);
    expect(content).not.toContain('AQ==');
    expect(content).toContain('[data URL redacted mime=image/webp bytes=1]');
    expect(content).toContain('[base64 redacted mime=image/webp bytes=1]');
  });

  it('redacts credentials embedded in client and upstream query strings', async () => {
    const secret = 'query-secret-value';
    const capture = new Upstream4xxCaptureService();
    await runWithUpstreamCaptureContext(
      captureContext({
        endpoint: `/v1beta/models/gemini-3.6-flash:generateContent?key=${secret}&id_token=${secret}&session_id=${secret}&cookie=${secret}&alt=sse`,
      }),
      () =>
        capture.capture({
          endpoint: `https://cloudcode-pa.googleapis.com/v1internal:generateContent?access_token=${secret}&authorization=${secret}&alt=sse`,
          status: 400,
          upstreamErrorBody: { error: { message: 'rejected' } },
          upstreamRequest: { request: { model: 'upstream-model' } },
        }),
    );

    const [file] = await captureFiles();
    const content = await fs.readFile(path.join(agentDirectory, CAPTURES_DIRECTORY, file), 'utf-8');
    expect(content).not.toContain(secret);
    expect(content).toContain('key=[REDACTED]');
    expect(content).toContain('access_token=[REDACTED]');
    expect(content).toContain('id_token=[REDACTED]');
    expect(content).toContain('session_id=[REDACTED]');
    expect(content).toContain('cookie=[REDACTED]');
    expect(content).toContain('authorization=[REDACTED]');
  });

  it('removes the oldest capture when writing the 51st file', async () => {
    const captureDirectory = path.join(agentDirectory, CAPTURES_DIRECTORY);
    await fs.mkdir(captureDirectory, { recursive: true });
    const existingFiles = Array.from({ length: 50 }, (_, index) =>
      path.join(captureDirectory, `existing-${index}.json`),
    );
    await Promise.all(existingFiles.map((file) => fs.writeFile(file, '{}', 'utf-8')));
    await fs.utimes(existingFiles[0], new Date(0), new Date(0));

    await writeCapture();

    const files = await captureFiles();
    expect(files).toHaveLength(50);
    expect(files).not.toContain(path.basename(existingFiles[0]));
  });

  it('evicts the oldest capture to respect the aggregate directory byte budget', async () => {
    await writeCapture();

    const [oldestFile] = await captureFiles();
    const captureDirectory = path.join(agentDirectory, CAPTURES_DIRECTORY);
    const oldestPath = path.join(captureDirectory, oldestFile);
    const oldestSize = (await fs.stat(oldestPath)).size;
    await fs.utimes(oldestPath, new Date(0), new Date(0));
    process.env[CAPTURE_DIRECTORY_MAX_BYTES_ENV] = String(oldestSize * 2 - 1);

    await writeCapture();

    const files = await captureFiles();
    expect(files).toHaveLength(1);
    expect(files).not.toContain(oldestFile);
    expect(await captureDirectoryBytes()).toBeLessThanOrEqual(
      Number(process.env[CAPTURE_DIRECTORY_MAX_BYTES_ENV]),
    );
  });

  it('enforces the count and aggregate byte limits without touching unrelated files', async () => {
    await writeCapture();

    const captureDirectory = path.join(agentDirectory, CAPTURES_DIRECTORY);
    const [probeFile] = await captureFiles();
    const probePath = path.join(captureDirectory, probeFile);
    const probeSize = (await fs.stat(probePath)).size;
    await fs.unlink(probePath);

    const fixtureFiles = Array.from({ length: 50 }, (_, index) =>
      path.join(captureDirectory, `fixture-${index}.json`),
    );
    await Promise.all(
      fixtureFiles.map(async (file, index) => {
        await fs.writeFile(file, 'x'.repeat(64), 'utf-8');
        const timestamp = new Date(index * 1000);
        await fs.utimes(file, timestamp, timestamp);
      }),
    );
    const unrelatedPath = path.join(captureDirectory, 'preserve.txt');
    await fs.writeFile(unrelatedPath, 'preserve', 'utf-8');

    process.env[CAPTURE_DIRECTORY_MAX_BYTES_ENV] = String(probeSize + 1_600);
    await writeCapture();

    const files = await captureFiles();
    expect(files).not.toContain('fixture-0.json');
    expect(files).toContain('preserve.txt');
    expect(files.filter((file) => file.endsWith('.json')).length).toBeLessThan(CAPTURE_LIMIT);
    expect(await captureDirectoryBytes()).toBeLessThanOrEqual(
      Number(process.env[CAPTURE_DIRECTORY_MAX_BYTES_ENV]),
    );
  });

  it('serializes concurrent captures before enforcing aggregate retention', async () => {
    await writeCapture();

    const captureDirectory = path.join(agentDirectory, CAPTURES_DIRECTORY);
    const [probeFile] = await captureFiles();
    const probeSize = (await fs.stat(path.join(captureDirectory, probeFile))).size;
    await fs.rm(path.join(captureDirectory, probeFile));
    process.env[CAPTURE_DIRECTORY_MAX_BYTES_ENV] = String(probeSize + 1);

    await Promise.all(Array.from({ length: 8 }, () => writeCapture()));

    expect((await captureFiles()).filter((file) => file.endsWith('.json'))).toHaveLength(1);
    expect(await captureDirectoryBytes()).toBeLessThanOrEqual(
      Number(process.env[CAPTURE_DIRECTORY_MAX_BYTES_ENV]),
    );
  });

  it('limits outstanding diagnostic captures to bound queued payload memory', async () => {
    await Promise.all(Array.from({ length: 5 }, () => writeCapture()));

    expect((await captureFiles()).filter((file) => file.endsWith('.json'))).toHaveLength(4);
  });

  it('bounds individual upstream request and response payloads before serialization', async () => {
    await writeCapture({
      upstreamRequest: {
        request: { model: 'upstream-model', prompt: 'large prompt! '.repeat(200_000) },
      },
      upstreamErrorBody: { error: { message: 'large rejection! '.repeat(200_000) } },
    });

    const [file] = await captureFiles();
    const capturePath = path.join(agentDirectory, CAPTURES_DIRECTORY, file);
    const content = await fs.readFile(capturePath, 'utf-8');
    const document = JSON.parse(content) as {
      upstream_request: unknown;
      upstream_response: { error_body: unknown };
    };

    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(1024 * 1024);
    expect(
      Buffer.byteLength(JSON.stringify(document.upstream_request), 'utf-8'),
    ).toBeLessThanOrEqual(256 * 1024);
    expect(
      Buffer.byteLength(JSON.stringify(document.upstream_response.error_body), 'utf-8'),
    ).toBeLessThanOrEqual(256 * 1024);
  });

  it.skipIf(process.platform === 'win32')(
    'restricts capture directory and file permissions',
    async () => {
      await writeCapture();

      const directory = path.join(agentDirectory, CAPTURES_DIRECTORY);
      const [file] = await captureFiles();
      const directoryMode = (await fs.stat(directory)).mode & 0o777;
      const fileMode = (await fs.stat(path.join(directory, file))).mode & 0o777;

      expect(directoryMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    },
  );

  it('swallows a capture write failure', async () => {
    const writeFile = vi
      .spyOn(fs, 'writeFile')
      .mockRejectedValueOnce(new Error('disk is unavailable'));

    await expect(writeCapture()).resolves.toBeUndefined();
    expect(writeFile).toHaveBeenCalledOnce();
  });
});
