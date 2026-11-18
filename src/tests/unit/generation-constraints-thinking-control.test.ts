import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { GenerationConstraintsService } from '@/server/gateway/shared/services/generation-constraints.service';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import type { ModelThinkingTransport } from '@/server/gateway/common/model-thinking-transport';

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
afterEach(() => setServerConfig(previous));

function gatewayBudget(budget: number) {
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    thinking_budget: {
      ...DEFAULT_APP_CONFIG.proxy.thinking_budget,
      control_source: 'gateway',
      claude_budget: budget,
      claude_high: 4096,
    },
  });
}

function request(): GeminiInternalRequest {
  return {
    model: 'claude-sonnet-4-6-thinking',
    requestId: 'd09-request',
    userAgent: 'test',
    requestType: 'agent',
    request: { contents: [{ role: 'user', parts: [{ text: 'Reply briefly' }] }] },
  };
}

function policy(transport?: ModelThinkingTransport, cap = 64000) {
  return new GenerationConstraintsService({
    getModelOutputLimitForAccount: () => cap,
    getModelThinkingBudgetForAccount: () => 32768,
    getModelThinkingTransportForAccount: () => transport,
  });
}

it('uses the Claude Default field for an unsuffixed thinking route even if the High field differs', () => {
  gatewayBudget(8192);
  const body = request();
  policy().applyInternalGenerationConstraints(body, body.model, 'account');
  expect(body.request.generationConfig).toEqual({
    maxOutputTokens: 9216,
    thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 },
  });
});

it('keeps an explicit adaptive gateway setting with a smaller account output cap', () => {
  gatewayBudget(-1);
  const body = request();
  policy({ kind: 'budget', defaultBudget: 32768 }, 1024).applyInternalGenerationConstraints(
    body,
    body.model,
    'account',
  );
  expect(body.request.generationConfig).toEqual({
    maxOutputTokens: 1024,
    thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
  });
});

it('uses the declared model default for a legacy gateway zero', () => {
  gatewayBudget(0);
  const body = request();
  policy({ kind: 'budget', defaultBudget: 1024 }).applyInternalGenerationConstraints(
    body,
    body.model,
    'account',
  );
  expect(body.request.generationConfig).toEqual({
    maxOutputTokens: 2048,
    thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 },
  });
});

it('uses declared default thinking when the model has no matching gateway family setting', () => {
  gatewayBudget(-1);
  const body = request();
  body.model = 'provider-reasoning-model';
  policy({ kind: 'budget', defaultBudget: 1024 }).applyInternalGenerationConstraints(
    body,
    body.model,
    'account',
  );
  expect(body.request.generationConfig).toEqual({
    maxOutputTokens: 2048,
    thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 },
  });
});

it('keeps level transport exclusive and enforces the current account output cap', () => {
  gatewayBudget(-1);
  const body = request();
  body.request.generationConfig = {
    maxOutputTokens: 20000,
    thinkingConfig: { includeThoughts: true, thinkingBudget: 1234 },
  };
  policy({ kind: 'level', defaultLevel: 'high' }, 4096).applyInternalGenerationConstraints(
    body,
    body.model,
    'account',
  );
  expect(body.request.generationConfig).toEqual({
    maxOutputTokens: 4096,
    thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' },
  });
});

it('resolves the declared channel separately for each selected account', () => {
  gatewayBudget(-1);
  const readTransport = vi.fn(
    (id: string): ModelThinkingTransport =>
      id === 'first'
        ? { kind: 'level', defaultLevel: 'low' }
        : { kind: 'budget', defaultBudget: 1024 },
  );
  const service = new GenerationConstraintsService({
    getModelOutputLimitForAccount: () => 4096,
    getModelThinkingBudgetForAccount: () => 32768,
    getModelThinkingTransportForAccount: readTransport,
  });
  const first = request();
  const second = request();
  service.applyInternalGenerationConstraints(first, first.model, 'first');
  service.applyInternalGenerationConstraints(second, second.model, 'second');
  expect([first.request.generationConfig, second.request.generationConfig]).toEqual([
    { maxOutputTokens: 4096, thinkingConfig: { includeThoughts: true, thinkingLevel: 'LOW' } },
    { maxOutputTokens: 4096, thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
  ]);
});

it('omits thinking when the provider declares it unsupported', () => {
  gatewayBudget(8192);
  const body = request();
  body.request.generationConfig = {
    maxOutputTokens: 10000,
    thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 },
  };
  policy({ kind: 'disabled' }, 4096).applyInternalGenerationConstraints(
    body,
    body.model,
    'account',
  );
  expect(body.request.generationConfig).toEqual({ maxOutputTokens: 4096 });
});
