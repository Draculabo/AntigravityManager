import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
import { ModelRouteMissJournalService } from '@/modules/proxy-gateway/server/shared/services/model-route-miss-journal.service';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/shared/services/model-routing.service';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import {
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
} from './proxy-real-path.harness';

/**
 * The miss journal (`be5f76e`) previously had no caller: `resolveTargetModel` could not tell
 * "resolved to itself because it's canonical" apart from "resolved to nothing, forwarded the
 * client string as-is". This exercises the wiring that now makes that distinction and records
 * only the second case.
 */

vi.mock(
  '@/modules/proxy-gateway/server/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRequestUserAgent: async () => 'antigravity-parity-harness/0.0.0',
  }),
);

describe('ModelRoutingService route-miss recording', () => {
  it('does not record a canonical model as a miss', () => {
    const journal = new ModelRouteMissJournalService();
    const policy = new ModelRoutingService(journal);

    policy.resolveModelRouteForRequest('gemini-3-flash');

    expect(journal.getSnapshot()).toEqual([]);
  });

  it('records a genuine miss exactly once for that call', () => {
    const journal = new ModelRouteMissJournalService();
    const policy = new ModelRoutingService(journal);

    policy.resolveModelRouteForRequest('totally-unknown-model-abc');

    const snapshot = journal.getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ count: 1, model: 'totally-unknown-model-abc' });
  });

  it('does not record anything from the pure resolveModelRoute lookup, even called repeatedly', () => {
    const journal = new ModelRouteMissJournalService();
    const policy = new ModelRoutingService(journal);

    policy.resolveModelRoute('totally-unknown-model-pure');
    policy.resolveModelRoute('totally-unknown-model-pure');
    policy.resolveModelRoute('totally-unknown-model-pure');

    expect(journal.getSnapshot()).toEqual([]);
  });
});

describe('Model route miss recording over the real request chain', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
  });

  it('records exactly one miss for an Anthropic count_tokens request, despite resolving the model twice internally', async () => {
    const journal = new ModelRouteMissJournalService();
    const upstream = createUpstream({ countTokens: { totalTokens: 5 } });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new AnthropicController(
      createGateway(upstream, lease, journal).anthropicService,
    );

    await controller.countTokens(
      {
        messages: [{ content: 'hello', role: 'user' }],
        model: 'totally-unmapped-anthropic-model',
      } as never,
      createReply() as never,
    );

    const snapshot = journal.getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      count: 1,
      model: 'totally-unmapped-anthropic-model',
    });
  });

  it('does not record a miss for a canonical Anthropic count_tokens request', async () => {
    const journal = new ModelRouteMissJournalService();
    const upstream = createUpstream({ countTokens: { totalTokens: 5 } });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new AnthropicController(
      createGateway(upstream, lease, journal).anthropicService,
    );

    await controller.countTokens(
      {
        messages: [{ content: 'hello', role: 'user' }],
        model: 'claude-sonnet-4-5',
      } as never,
      createReply() as never,
    );

    expect(journal.getSnapshot()).toEqual([]);
  });
});
