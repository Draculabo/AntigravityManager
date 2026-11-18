// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import type { GeminiResponse } from '@/server/gateway/common/interfaces/request-interfaces';
import { OpenAIChatController } from '@/server/gateway/modules/openai/openai-chat.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIResponsesController } from '@/server/gateway/modules/openai/responses/openai-responses.controller';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { PIXEL_PNG } from '../fixtures/image-content';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiStreamFrame,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));
vi.mock('@/server/gateway/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'tool-declaration-test/1.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
let app: NestFastifyApplication | undefined;
const key = 'tool-declaration-fixture';
const patch = '--- a/example.ts\r\n+++ b/example.ts\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n';
const functionArgs = { command: ['apply_patch', patch], context: { file: 'example.ts' } };
const user = { role: 'user', content: 'Pass the tool input.' };

afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
    setServerConfig(previous);
  }
});

async function fixture(args?: Record<string, unknown>, finishAfterTool = false) {
  const response: GeminiResponse = geminiTextResponse('Finished');
  if (args) {
    response.candidates = [
      {
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'apply_patch', args, id: 'call_patch' } }],
        },
        finishReason: 'STOP',
      },
    ];
  }
  const frames = [geminiStreamFrame({ ...response })];
  const upstream = createUpstream({ generate: response, streamFrames: frames });
  if (finishAfterTool) {
    const sendUpstream = upstream.streamGenerateInternal.getMockImplementation();
    if (!sendUpstream) {
      throw new Error('Expected the fixture stream implementation');
    }
    upstream.streamGenerateInternal.mockImplementationOnce(async (...parameters) => {
      const result = await sendUpstream(...parameters);
      frames[0] = geminiStreamFrame(geminiTextResponse('Tool result received.'));
      return result;
    });
  }
  const gateway = createGateway(upstream, createLease([createAccount('tool-declaration')]));
  const operations = new OpenAIOperations(gateway.openAIService);
  @Module({
    controllers: [OpenAIChatController, OpenAIResponsesController],
    providers: [ProxyGuard, { provide: OpenAIOperations, useValue: operations }],
  })
  class ToolsModule {}
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    api_key: key,
    custom_mapping: { 'gpt-5.5': 'gemini-3-flash' },
  });
  app = await NestFactory.create<NestFastifyApplication>(ToolsModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const send = (route: string, payload: object) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3-flash', store: false, ...payload }),
      signal: AbortSignal.timeout(7_000),
    });
  return { send, upstream, base };
}

function events(wire: string) {
  return wire
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)));
}

const codexExecutable = process.env.AGM_CODEX_EXE;
it.runIf(Boolean(codexExecutable))(
  'round-trips a real patch failure from installed Codex',
  async () => {
    if (!codexExecutable) {
      throw new Error('The installed Codex executable must be supplied');
    }
    const target = 'd28-missing-fixture.txt';
    const invalidPatch = `*** Begin Patch\n*** Update File: ${target}\n@@\n-old\n+new\n*** End Patch`;
    const { base, upstream } = await fixture({ input: invalidPatch }, true);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agm-d28-codex-'));
    if (
      path.dirname(directory) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith('agm-d28-codex-')
    ) {
      throw new Error('Unexpected isolated client directory');
    }
    try {
      const execution = promisify(execFile)(
        codexExecutable,
        [
          'exec',
          '--skip-git-repo-check',
          '--ephemeral',
          '--json',
          '--sandbox',
          'workspace-write',
          '-C',
          directory,
          '-c',
          'model_provider="d28_fixture"',
          '-c',
          'model="gpt-5.5"',
          '-c',
          'model_providers.d28_fixture.name="D28 local fixture"',
          '-c',
          `model_providers.d28_fixture.base_url="${base}"`,
          '-c',
          'model_providers.d28_fixture.wire_api="responses"',
          '-c',
          'model_providers.d28_fixture.env_key="AGM_D28_TEST_KEY"',
          '-c',
          'model_providers.d28_fixture.requires_openai_auth=false',
          '-c',
          'analytics.enabled=false',
          '-c',
          'feedback.enabled=false',
          'Attempt the supplied patch and report the result.',
        ],
        {
          env: { ...process.env, CODEX_HOME: directory, AGM_D28_TEST_KEY: key },
          cwd: directory,
          windowsHide: true,
          timeout: 35_000,
          maxBuffer: 128 * 1024,
        },
      );
      execution.child.stdin?.end();
      const result = await execution;
      expect(result.stdout).toContain('Tool result received.');
      expect(upstream.calls).toHaveLength(2);
      const parts = upstream.calls[1]?.body.request.contents.flatMap((content) => content.parts);
      expect(
        parts?.flatMap((part) => (part.functionCall ? [part.functionCall] : [])),
      ).toContainEqual({
        name: 'apply_patch',
        id: 'call_patch',
        args: { input: invalidPatch },
      });
      expect(
        parts?.flatMap((part) => (part.functionResponse ? [part.functionResponse] : [])),
      ).toContainEqual({
        name: 'apply_patch',
        id: 'call_patch',
        response: { result: expect.stringContaining(target) },
      });
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
    }
  },
  45_000,
);

it.each([false, true])(
  'honors declared Responses types and preserves their payloads (stream=%s)',
  async (stream) => {
    const { send } = await fixture({ ...functionArgs, input: patch });
    for (const type of ['function', 'custom']) {
      const response = await send('/v1/responses', {
        input: [user],
        tools: [{ type, name: 'apply_patch' }],
        stream,
      });
      const wire = await response.text();
      expect(response.status, wire).toBe(200);
      const output = stream
        ? events(wire).find((event) => event.type === 'response.completed')?.response.output
        : JSON.parse(wire).output;
      expect(output).toEqual([
        {
          call_id: 'call_patch',
          id: expect.any(String),
          name: 'apply_patch',
          status: 'completed',
          ...(type === 'custom'
            ? { type: 'custom_tool_call', input: patch }
            : {
                type: 'function_call',
                arguments: JSON.stringify({ ...functionArgs, input: patch }),
              }),
        },
      ]);
    }
  },
);

it.each([false, true])(
  'emits native Chat custom calls from nested declarations (stream=%s)',
  async (stream) => {
    const { send } = await fixture({ input: patch });
    const response = await send('/v1/chat/completions', {
      messages: [user],
      tools: [{ type: 'custom', custom: { name: 'apply_patch' } }],
      stream,
    });
    const wire = await response.text();
    expect(response.status, wire).toBe(200);
    const calls = stream
      ? events(wire).flatMap((event) =>
          event.choices.flatMap(
            (choice: { delta: { tool_calls?: unknown[] } }) => choice.delta.tool_calls ?? [],
          ),
        )
      : JSON.parse(wire).choices[0].message.tool_calls;
    expect(calls).toEqual([
      {
        ...(stream ? { index: 0 } : {}),
        id: 'call_patch',
        type: 'custom',
        custom: { name: 'apply_patch', input: patch },
      },
    ]);
  },
);

it('replays Chat custom history with the unchanged payload and associated result', async () => {
  const { send, upstream } = await fixture();
  const response = await send('/v1/chat/completions', {
    messages: [
      user,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_patch', type: 'custom', custom: { name: 'apply_patch', input: patch } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_patch', content: 'Patch failure details' },
    ],
  });
  expect(response.status, await response.text()).toBe(200);
  const parts = upstream.calls[0]?.body.request.contents.flatMap((content) => content.parts);
  expect(parts?.flatMap((part) => (part.functionCall ? [part.functionCall] : []))).toEqual([
    { name: 'apply_patch', id: 'call_patch', args: { input: patch } },
  ]);
  expect(parts?.flatMap((part) => (part.functionResponse ? [part.functionResponse] : []))).toEqual([
    { name: 'apply_patch', id: 'call_patch', response: { result: 'Patch failure details' } },
  ]);
});

it('delivers all patch failures and media to the upstream request', async () => {
  const { send, upstream } = await fixture();
  const prefix = [
    'apply_patch verification failed',
    ...Array.from({ length: 7 }, (_, index) => `Context ${index}`),
  ].join('\n');
  const failures = Array.from({ length: 8 }, (_, index) => ({
    id: `call_patch_${index}`,
    text: index < 2 ? `${prefix}\nFile ${index}` : `Failed to find context in file ${index}`,
  }));
  const encoded = PIXEL_PNG.toString('base64');
  const response = await send('/v1/responses', {
    input: [
      user,
      ...failures.flatMap(({ id, text }) => [
        { type: 'custom_tool_call', call_id: id, name: 'apply_patch', input: patch },
        {
          type: 'custom_tool_call_output',
          call_id: id,
          output: [
            { type: 'input_text', text },
            ...(id === 'call_patch_7'
              ? [{ type: 'input_image', image_url: `data:image/png;base64,${encoded}` }]
              : []),
          ],
        },
      ]),
    ],
  });
  expect(response.status, await response.text()).toBe(200);
  const parts = upstream.calls[0]?.body.request.contents.flatMap((content) => content.parts);
  expect(parts?.flatMap((part) => (part.functionResponse ? [part.functionResponse] : []))).toEqual(
    failures.map(({ id, text }) => ({ id, name: 'apply_patch', response: { result: text } })),
  );
  expect(parts?.flatMap((part) => (part.inlineData ? [part.inlineData] : []))).toEqual([
    { mimeType: 'image/png', data: encoded },
  ]);
});
