import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';

const transport = vi.hoisted(() => ({
  post: vi.fn(),
  create: vi.fn(() => ({ get: vi.fn(), post: vi.fn() })),
  isAxiosError: vi.fn(),
}));
vi.mock('axios', () => ({ default: transport, ...transport }));
vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'recovery-protocol-test/1.0',
}));
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const inputLimit = 'The input token count exceeds the maximum number of tokens allowed';
const failures = [
  { status: 429, message: 'Rate limit exceeded' },
  { status: 400, message: 'Invalid thought signature' },
  { status: 400, message: 'Project not found' },
];
function failure(status: number, message: string) {
  return { message, response: { status, headers: {}, data: { error: { message } } } };
}
beforeEach(() => {
  transport.post.mockReset();
  transport.isAxiosError.mockImplementation(
    (value: unknown) => typeof value === 'object' && value !== null && 'response' in value,
  );
  vi.stubEnv('PROXY_INTERNAL_BASE_URLS', '');
  vi.stubEnv('ANTIGRAVITY_INTERNAL_BASE_URLS', '');
  vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, request_timeout: 1 });
  vi.spyOn(thoughtStoreService, 'prepareInternalRequest').mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setServerConfig(previous);
  proxyModelAvailabilityStore.clearAccount('acc-1');
  proxyModelAvailabilityStore.clearAccount('acc-2');
});

describe('final context recovery failure through actual protocol and client services', () => {
  it('preserves scoped recovery options in the native Gemini stream project fallback', async () => {
    const capture = new Upstream4xxCaptureService();
    vi.spyOn(capture, 'capture').mockResolvedValue();
    const client = new GeminiClient(capture);
    const upstream = createUpstream({});
    upstream.streamGenerateInternal
      .mockRejectedValueOnce(
        new UpstreamRequestError({
          status: 400,
          message: "Resource 'projects/test-project' could not be found",
        }),
      )
      .mockImplementation(async (...args) => {
        const stream = await client.streamGenerateInternal(...args);
        if (!(stream instanceof Readable)) {
          throw new Error('Expected the Axios fixture to return a Node Readable');
        }
        return stream;
      });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const gateway = createGateway(upstream, lease);
    transport.post
      .mockRejectedValueOnce(failure(400, inputLimit))
      .mockRejectedValue(failure(429, 'Rate limit exceeded'));
    await expect(
      gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', {
        contents: [{ role: 'user', parts: [{ text: 'Synthetic task' }] }],
      }),
    ).rejects.toMatchObject({
      status: 429,
      message: 'Rate limit exceeded',
      cause: { status: 400, message: inputLimit },
    });
    const [first, second] = upstream.streamGenerateInternal.mock.calls.map((call) => call[5]);
    expect(first?.upstreamSession).toBeDefined();
    expect(second?.upstreamSession).toEqual(first?.upstreamSession);
    expect(second?.recoveryBudget).toBe(first?.recoveryBudget);
    expect(second?.canRecoverUpstreamSession?.()).toBe(true);
    expect(upstream.streamGenerateInternal).toHaveBeenCalledTimes(2);
    expect(transport.post).toHaveBeenCalledTimes(2);
    expect(lease.getNextToken).toHaveBeenCalledOnce();
    expect(lease.penalties).toEqual([]);
  });

  it.each([false, true])(
    'releases the selected image permit on final recovery failure, stream=%s',
    async (stream) => {
      const capture = new Upstream4xxCaptureService();
      vi.spyOn(capture, 'capture').mockResolvedValue();
      const client = new GeminiClient(capture);
      const upstream = createUpstream({});
      upstream.generateInternal.mockImplementation(client.generateInternal.bind(client));
      upstream.streamGenerateInternal.mockImplementation(async (...args) => {
        const result = await client.streamGenerateInternal(...args);
        if (!(result instanceof Readable)) {
          throw new Error('Expected the Axios fixture to return a Node Readable');
        }
        return result;
      });
      const account = createAccount('acc-1');
      const release = vi.fn();
      const lease = {
        ...createLease([account]),
        getNextImageToken: vi.fn(async () => ({ token: account, permit: { release } })),
      };
      const gateway = createGateway(upstream, lease);
      transport.post
        .mockRejectedValueOnce(failure(400, inputLimit))
        .mockRejectedValue(failure(429, 'Rate limit exceeded'));
      const request = { contents: [{ role: 'user', parts: [{ text: 'Synthetic image task' }] }] };
      await expect(
        stream
          ? gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-pro-image', request)
          : gateway.geminiService.handleGeminiGenerateContent(
              'gemini-3-pro-image',
              request,
              'image_gen',
            ),
      ).rejects.toMatchObject({ status: 429, cause: { status: 400, message: inputLimit } });
      expect(transport.post).toHaveBeenCalledTimes(2);
      expect(lease.getNextImageToken).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(lease.penalties).toEqual([]);
    },
  );

  it.each(
    (['chat', 'responses', 'anthropic', 'gemini'] as const).flatMap((surface) =>
      [false, true].flatMap((stream) => failures.map((final) => ({ surface, stream, ...final }))),
    ),
  )('terminates $surface stream=$stream status=$status message=$message', async (test) => {
    const capture = new Upstream4xxCaptureService();
    vi.spyOn(capture, 'capture').mockResolvedValue();
    const client = new GeminiClient(capture);
    // Keep the shared gateway fixture while replacing its transport stub with the real client.
    const upstream = createUpstream({});
    upstream.generateInternal.mockImplementation(client.generateInternal.bind(client));
    upstream.streamGenerateInternal.mockImplementation(async (...args) => {
      const stream = await client.streamGenerateInternal(...args);
      if (!(stream instanceof Readable)) {
        throw new Error('Expected the Axios fixture to return a Node Readable');
      }
      return stream;
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const gateway = createGateway(upstream, lease);
    transport.post
      .mockRejectedValueOnce(failure(400, inputLimit))
      .mockRejectedValue(failure(test.status, test.message));
    const context = { headers: { 'x-session-id': 'synthetic-session' } };
    const request = {
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'Synthetic task' }],
      stream: test.stream,
    };
    const execute = () => {
      if (test.surface === 'gemini') {
        const body = { contents: [{ role: 'user', parts: [{ text: 'Synthetic task' }] }] };
        return test.stream
          ? gateway.geminiService.handleGeminiStreamGenerateContent(
              request.model,
              body,
              undefined,
              context,
            )
          : gateway.geminiService.handleGeminiGenerateContent(
              request.model,
              body,
              'generate-content',
              undefined,
              'gemini',
              context,
            );
      }
      if (test.surface === 'anthropic') {
        return gateway.anthropicService.handleAnthropicMessages(request, context);
      }
      return gateway.openAIService.handleChatCompletions(
        request,
        test.surface === 'responses' ? 'responses' : 'chat-completions',
        undefined,
        undefined,
        undefined,
        context,
      );
    };
    await expect(execute()).rejects.toMatchObject({
      status: test.status,
      message: test.message,
      cause: { status: 400, message: inputLimit },
    });
    expect(transport.post).toHaveBeenCalledTimes(2);
    expect(lease.getNextToken).toHaveBeenCalledOnce();
    expect(lease.penalties).toEqual([]);
    expect(lease.commitSession).not.toHaveBeenCalled();
    expect(lease.markModelSuccess).not.toHaveBeenCalled();
  });
});
