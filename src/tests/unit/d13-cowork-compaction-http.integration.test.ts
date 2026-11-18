// @vitest-environment node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import type {
  AnthropicChatRequest,
  AnthropicMessage,
} from '@/server/gateway/common/interfaces/request-interfaces';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import {
  createAccount,
  createGateway,
  createLease,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));
vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'd13-loopback-fixture',
  buildContentRequestUserAgent: () => 'd13-loopback-fixture',
}));

const cleanup: Array<() => void | Promise<void>> = [];
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const key = 'synthetic-d13-key';
const sourceHeader = 'X-AGM-Response-Source';
const operationHeader = 'X-AGM-Compaction-Operation';
const summary = 'Preserve the exact deployment constraint from the previous conversation.';
const normalAnswer = 'Continued through the provider.';
const largeHistory = 'Retain this prior historical constraint. '.repeat(7_000);
const history: AnthropicMessage[] = [
  { role: 'user', content: largeHistory },
  { role: 'assistant', content: 'I recorded the constraints.' },
];
const systemSummary: AnthropicChatRequest['system'] = [
  { type: 'text', text: 'A separate system instruction.' },
  { type: 'text', text: 'You are tasked with summarizing conversations.' },
];

async function postMessages(url: string, headers: Record<string, string>, body: string) {
  const curl = process.env.AGM_D13_CURL_EXE;
  if (!curl) {
    return fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
  }
  const pending = promisify(execFile)(
    curl,
    [
      '--disable',
      '--silent',
      '--show-error',
      '--include',
      '--noproxy',
      '*',
      '--max-time',
      '10',
      ...Object.entries(headers).flatMap(([name, value]) => ['--header', `${name}: ${value}`]),
      '--header',
      'Expect:',
      '--data-binary',
      '@-',
      url,
    ],
    { windowsHide: true, timeout: 11_000 },
  );
  const stdin = pending.child.stdin;
  if (!stdin) {
    throw new Error('Expected piped curl stdin');
  }
  const [{ stdout }] = await Promise.all([pending, pipeline(Readable.from([body]), stdin)]);
  const response = /^HTTP\/1\.[01] (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/u.exec(
    stdout,
  );
  if (!response) {
    throw new Error('Expected curl to return an HTTP response with headers');
  }
  const responseHeaders = new Headers();
  for (const line of response[2].split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    responseHeaders.append(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return new Response(response[3], { status: Number(response[1]), headers: responseHeaders });
}

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) {
      await close();
    }
  } finally {
    setServerConfig(previous);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

function continuation(position: 4 | 5, text = summary): AnthropicMessage[] {
  const preceding: AnthropicMessage[] = [
    { role: 'user', content: '<system-reminder>Fixture reminder.</system-reminder>' },
    { role: 'assistant', content: 'Acknowledged.' },
    { role: 'user', content: 'Environment details.' },
    { role: 'assistant', content: 'Read.' },
  ];
  return [
    ...preceding.slice(0, position - 1),
    {
      role: 'user',
      content: `This session is being continued from a previous conversation.\n<summary>${text}</summary>`,
    },
  ];
}

async function fixture(auto = false) {
  const upstreamPaths: string[] = [];
  let next: { answer: string } | { failure: string } = { answer: normalAnswer };
  const upstream = createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      upstreamPaths.push(request.url ?? '');
      if ('failure' in next) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: { code: 400, status: 'INVALID_ARGUMENT', message: next.failure },
          }),
        );
        return;
      }
      const body = JSON.stringify({ response: geminiTextResponse(next.answer) });
      if (request.url?.includes(':streamGenerateContent')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${body}\n\n`);
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  cleanup.push(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = upstream.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected an allocated upstream loopback port');
  }
  vi.stubEnv('PROXY_INTERNAL_BASE_URLS', `http://127.0.0.1:${address.port}/v1internal`);
  vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
  vi.stubEnv('NO_PROXY', '127.0.0.1');
  vi.stubEnv('no_proxy', '127.0.0.1');
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    api_key: key,
    traffic_audit: { ...DEFAULT_APP_CONFIG.proxy.traffic_audit, enabled: false },
    cowork_compaction: {
      ...DEFAULT_APP_CONFIG.proxy.cowork_compaction,
      manual_enabled: true,
      auto_enabled: auto,
      auto_threshold: 50_000,
      trusted_client_key_hashes: [createHash('sha256').update(key).digest('hex')],
    },
  });
  const client = new GeminiClient(new Upstream4xxCaptureService());
  cleanup.push(() => client.onModuleDestroy());
  const lease = createLease([createAccount('synthetic-d13-account')]);
  const { anthropicService } = createGateway(client as never, lease);
  @Module({
    controllers: [AnthropicController],
    providers: [ProxyGuard, { provide: AnthropicService, useValue: anthropicService }],
  })
  class CoworkHttpModule {}
  const app = await NestFactory.create(CoworkHttpModule, new FastifyAdapter(), { logger: false });
  cleanup.push(() => app.close());
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();

  const send = (
    messages: AnthropicMessage[],
    options: {
      stream?: boolean;
      session?: string;
      system?: AnthropicChatRequest['system'];
    } = {},
  ) =>
    postMessages(
      `${origin}/v1/messages`,
      {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'x-claude-code-session-id': options.session ?? 'd13-primary-session',
      },
      JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 128,
        messages,
        stream: options.stream ?? false,
        system: options.system,
      }),
    );
  return {
    send,
    lease,
    upstreamPaths,
    setReply: (value: typeof next) => {
      next = value;
    },
  };
}

const manualRequest = (command: string): AnthropicMessage[] => [
  ...history,
  { role: 'user', content: command },
];
const summarizeRequest = (messages = history): AnthropicMessage[] => [
  ...messages,
  { role: 'user', content: 'Extract the key facts for the next turn.' },
];

async function expectTrigger(response: Response): Promise<string> {
  expect(response.status).toBe(400);
  expect(response.headers.get(sourceHeader)).toBe('local_compaction_trigger');
  expect(await response.text()).toContain('prompt is too long:');
  const id = response.headers.get(operationHeader);
  if (!id) {
    throw new Error('Expected a compaction operation identifier');
  }
  return id;
}

async function expectProvider(response: Response, text = normalAnswer): Promise<void> {
  expect(response.status).toBe(200);
  expect(response.headers.get(sourceHeader)).toBeNull();
  expect(await response.text()).toContain(text);
}

it.each([
  [4, false],
  [5, true],
] as const)(
  'adopts the exact summary at message %i through Messages HTTP (stream=%s)',
  async (position, stream) => {
    const { send, setReply, upstreamPaths, lease } = await fixture();
    await expectTrigger(await send(manualRequest('/compact.'), { stream }));
    expect(upstreamPaths).toEqual([]);
    expect(lease.markFromUpstreamError).not.toHaveBeenCalled();

    setReply({ answer: summary });
    const providerSummary = await send(summarizeRequest(), { system: systemSummary, stream });
    expect(providerSummary.status).toBe(200);
    expect(providerSummary.headers.get(sourceHeader)).toBeNull();
    const summaryOutput = await providerSummary.text();
    expect(summaryOutput).toContain(summary);
    if (stream) {
      expect(summaryOutput).toContain('"stop_reason":"end_turn"');
      expect(summaryOutput.split('event: message_stop')).toHaveLength(2);
    }
    setReply({ answer: normalAnswer });
    await expectProvider(await send(continuation(position, 'An unrelated summary.'), { stream }));
    await expectProvider(
      await send(continuation(position), { session: 'd13-other-session', stream }),
    );

    const adopted = await send(continuation(position), { stream });
    expect(adopted.status).toBe(200);
    expect(adopted.headers.get(sourceHeader)).toBe('local_compaction_acknowledgement');
    const output = await adopted.text();
    expect(output).toContain('Compacted conversation.');
    expect(output).toContain('"input_tokens":0');
    expect(output).toContain('"output_tokens":0');
    if (stream) {
      expect(output.split('event: message_stop')).toHaveLength(2);
    }
    expect(upstreamPaths).toHaveLength(3);
    expect(lease.markFromUpstreamError).not.toHaveBeenCalled();
  },
  20_000,
);

it('binds system summary detection to the exact original history and expires adopted protection', async () => {
  const { send, setReply, upstreamPaths } = await fixture(true);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  const initial = await expectTrigger(await send(summarizeRequest(), { system: systemSummary }));
  expect(upstreamPaths).toEqual([]);

  setReply({ answer: 'An unrelated summary.' });
  await expectProvider(
    await send(
      summarizeRequest([{ role: 'user', content: 'Different initial history.' }, history[1]]),
      { system: systemSummary },
    ),
    'An unrelated summary.',
  );
  setReply({ answer: normalAnswer });
  await expectProvider(await send(continuation(4, 'An unrelated summary.')));

  setReply({ answer: summary });
  await expectProvider(await send(summarizeRequest(), { system: systemSummary }), summary);
  setReply({ answer: normalAnswer });
  const adopted = continuation(5);
  await expectProvider(await send(adopted));

  const longContinuation: AnthropicMessage[] = [
    ...adopted,
    { role: 'assistant', content: 'History resumed.' },
    { role: 'user', content: largeHistory },
  ];
  await expectProvider(await send(longContinuation));
  clock.mockReturnValue(Date.now() + 30_001);
  const afterExpiry = await expectTrigger(await send(longContinuation));
  expect(afterExpiry).not.toBe(initial);
  expect(upstreamPaths).toHaveLength(5);
}, 20_000);

it.each([false, true])(
  'confirms a Cowork prefix summary with leading reminders=%s only when the exact recent history is retained',
  async (leadingReminder) => {
    const { send, setReply, upstreamPaths } = await fixture();
    const retained: AnthropicMessage[] = [
      { role: 'assistant', content: 'I recorded the recent context.' },
      { role: 'user', content: 'Keep the recent constraint as well.' },
      { role: 'assistant', content: 'I will.' },
    ];
    const reminder = {
      type: 'text' as const,
      text: '<system-reminder>Test counter.</system-reminder>',
    };
    const prior: AnthropicMessage = {
      role: 'user',
      content: [reminder, { type: 'text', text: 'A detail from the early context.' }],
    };
    const command: AnthropicMessage = { role: 'user', content: '/compact.' };
    const cachedText = {
      type: 'text' as const,
      text: 'I recorded the constraints.',
      cache_control: { type: 'ephemeral' },
    };
    const nativePrompt = [
      'Summarize the earlier portion of the conversation so far for use when continuing the conversation.',
      'Use <analysis> and <summary> sections.',
      '<example><analysis>Reasoning.</analysis><summary>Facts.</summary></example>',
    ].join('\n');
    const summaryRequest: AnthropicMessage[] = [
      history[0],
      { role: 'assistant', content: [cachedText] },
      {
        role: 'user',
        content: [
          reminder,
          { type: 'text', text: 'A detail from the early context.\n' },
          { type: 'text', text: nativePrompt },
        ],
      },
    ];
    const followup: AnthropicMessage = {
      role: 'user',
      content: [
        reminder,
        { type: 'text', text: '<system-reminder>Workspace context.</system-reminder>' },
        { type: 'text', text: '/compact.' },
      ],
    };
    const continuationText = `This session is being continued from a previous conversation.\n<system-reminder>Prior tools.</system-reminder>\n\n${summary}`;
    const adopted: AnthropicMessage[] = [
      {
        role: 'user',
        content: leadingReminder
          ? [reminder, { type: 'text', text: continuationText }]
          : continuationText,
      },
      ...retained,
      followup,
    ];
    await expectTrigger(await send([...history, prior, ...retained, command], { stream: true }));

    const taggedSummary = `<analysis>Test analysis.</analysis>\n<summary>${summary}</summary>`;
    setReply({ answer: taggedSummary });
    await expectProvider(
      await send(
        [{ role: 'user', content: 'Different early history.' }, ...summaryRequest.slice(1)],
        {
          stream: true,
        },
      ),
      summary,
    );
    setReply({ answer: normalAnswer });
    await expectProvider(await send(adopted, { stream: true }));

    setReply({ answer: taggedSummary });
    await expectProvider(await send(summaryRequest, { stream: true }), summary);

    setReply({ answer: normalAnswer });
    const quotedEnvelope = adopted.map((message, index) =>
      index === 0
        ? { role: 'user', content: `Here is a quoted continuation example.\n${continuationText}` }
        : message,
    );
    await expectProvider(await send(quotedEnvelope, { stream: true }));
    const changedTail = adopted.map((message, index) =>
      index === 2 ? { role: 'user', content: 'Unrelated recent history.' } : message,
    );
    await expectProvider(await send(changedTail, { stream: true }));
    const otherSession = await send(adopted, { session: 'unrelated-session', stream: true });
    expect(otherSession.status).toBe(200);
    expect(await otherSession.text()).toContain('Conversation is already at minimal context.');

    const result = await send(adopted, { stream: true });
    expect(result.status).toBe(200);
    expect(result.headers.get(sourceHeader)).toBe('local_compaction_acknowledgement');
    expect(await result.text()).toContain('Compacted conversation.');
    expect(upstreamPaths).toHaveLength(5);
    await expectProvider(
      await send([...adopted.slice(0, -1), { role: 'user', content: 'What was the constraint?' }], {
        stream: true,
      }),
    );
    expect(upstreamPaths).toHaveLength(6);
  },
  20_000,
);

it('adopts automatic prefix compaction and resumes the pending request without a second trigger', async () => {
  const { send, setReply, upstreamPaths } = await fixture(true);
  const config = getServerConfig();
  if (!config) {
    throw new Error('Expected the gateway fixture configuration');
  }
  setServerConfig({
    ...config,
    cowork_compaction: { ...config.cowork_compaction, manual_enabled: false },
  });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  const prefix: AnthropicMessage[] = [
    ...history,
    { role: 'user', content: 'An early deployment constraint.' },
  ];
  const recent: AnthropicMessage[] = [
    { role: 'assistant', content: 'The recent task follows.' },
    { role: 'user', content: largeHistory },
  ];
  const initial = await expectTrigger(await send([...prefix, ...recent], { stream: true }));
  expect(upstreamPaths).toEqual([]);
  setReply({ answer: `<analysis>Fixture analysis.</analysis><summary>${summary}</summary>` });
  const summarize: AnthropicMessage[] = [
    ...history,
    {
      role: 'user',
      content: [
        { type: 'text', text: 'An early deployment constraint.\n' },
        {
          type: 'text',
          text: 'Summarize the earlier portion of the conversation so far for use when continuing the conversation. Use <analysis> and <summary>. <example>Facts.</example>',
        },
      ],
    },
  ];
  await expectProvider(await send(summarize, { stream: true }), summary);
  setReply({ answer: normalAnswer });
  const adopted: AnthropicMessage[] = [
    {
      role: 'user',
      content: `<system-reminder>Native reminder.</system-reminder>\nThis session is being continued from a previous conversation.\n\n${summary}`,
    },
    ...recent,
  ];
  await expectProvider(await send(adopted, { stream: true }));
  expect(upstreamPaths).toHaveLength(2);
  await expectProvider(await send(adopted, { stream: true }));
  expect(upstreamPaths).toHaveLength(3);
  clock.mockReturnValue(Date.now() + 30_001);
  const expired = await expectTrigger(await send(adopted, { stream: true }));
  expect(expired).not.toBe(initial);
  expect(upstreamPaths).toHaveLength(3);
}, 20_000);

it('releases a failed summary so another manual operation can start', async () => {
  const { send, setReply, upstreamPaths } = await fixture();
  const initial = await expectTrigger(await send(manualRequest('/compact')));
  setReply({ failure: 'Synthetic summary failure.' });
  const failed = await send(summarizeRequest(), { system: systemSummary });
  expect(failed.status).toBe(400);
  expect(failed.headers.get(sourceHeader)).toBeNull();
  expect(await failed.text()).toContain('Synthetic summary failure.');
  const sendsAfterFailure = upstreamPaths.length;
  expect(sendsAfterFailure).toBeGreaterThan(0);
  const next = await expectTrigger(await send(manualRequest('/compact')));
  expect(next).not.toBe(initial);
  expect(upstreamPaths).toHaveLength(sendsAfterFailure);
}, 20_000);
