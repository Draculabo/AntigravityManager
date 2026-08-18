import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runWithUpstreamCaptureContext,
  type UpstreamCaptureContext,
} from '@/modules/proxy-gateway/server/common/upstream-capture-context';
import { Upstream4xxCaptureService } from '@/modules/proxy-gateway/server/common/upstream-4xx-capture.service';

let agentDirectory = '';

vi.mock('@/shared/platform/paths', () => ({
  getAgentDir: vi.fn(() => agentDirectory),
}));

const CAPTURES_DIRECTORY = 'captures';

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

describe('upstream 4xx capture', () => {
  beforeEach(async () => {
    agentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-upstream-capture-'));
    process.env.AGM_UPSTREAM_4XX_CAPTURE = '1';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.AGM_UPSTREAM_4XX_CAPTURE;
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

  it('keeps capture files private on POSIX systems', async () => {
    if (process.platform === 'win32') {
      return;
    }

    await writeCapture();

    const [file] = await captureFiles();
    const captureDirectory = path.join(agentDirectory, CAPTURES_DIRECTORY);
    const directoryMode = (await fs.stat(captureDirectory)).mode & 0o777;
    const fileMode = (await fs.stat(path.join(captureDirectory, file))).mode & 0o777;

    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
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

  it('removes the oldest capture when writing the 51st file', async () => {
    await writeCapture();
    const [oldest] = await captureFiles();
    const oldestPath = path.join(agentDirectory, CAPTURES_DIRECTORY, oldest);
    await fs.utimes(oldestPath, new Date(0), new Date(0));

    for (let index = 0; index < 50; index++) {
      await writeCapture({ upstreamErrorBody: { error: { message: `rejected-${index}` } } });
    }

    const files = await captureFiles();
    expect(files).toHaveLength(50);
    expect(files).not.toContain(oldest);
  });

  it('swallows a capture write failure', async () => {
    const writeFile = vi
      .spyOn(fs, 'writeFile')
      .mockRejectedValueOnce(new Error('disk is unavailable'));

    await expect(writeCapture()).resolves.toBeUndefined();
    expect(writeFile).toHaveBeenCalledOnce();
  });
});
