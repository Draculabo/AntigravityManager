import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  GenerationDeadlineScope,
  observeGenerationStreamProgress,
} from '@/server/gateway/common/generation-deadline';

const policy = { initialMs: 180, activityMs: 120, transitionMs: 180 };
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => vi.useRealTimers());

it('allows one transition interval after thinking stops and resets it on real progress', async () => {
  const scope = new GenerationDeadlineScope(1000, undefined, policy);
  try {
    observeGenerationStreamProgress(scope.signal, 'thinking_only');
    await vi.advanceTimersByTimeAsync(121);
    expect(scope.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(170);
    expect(scope.signal.aborted).toBe(false);
    observeGenerationStreamProgress(scope.signal, 'output_started');
    await vi.advanceTimersByTimeAsync(120);
    expect(scope.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(180);
    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toMatchObject({ name: 'GenerationDeadlineExceededError' });
  } finally {
    scope.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('caps the transition at the original total request deadline', async () => {
  const scope = new GenerationDeadlineScope(200, undefined, policy);
  try {
    observeGenerationStreamProgress(scope.signal, 'thinking_only');
    await vi.advanceTimersByTimeAsync(199);
    expect(scope.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(scope.signal.aborted).toBe(true);
  } finally {
    scope.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('does not restart the initial phase for metadata-only waiting observations', async () => {
  const scope = new GenerationDeadlineScope(1000, undefined, policy);
  try {
    observeGenerationStreamProgress(scope.signal, 'waiting_for_output');
    await vi.advanceTimersByTimeAsync(150);
    observeGenerationStreamProgress(scope.signal, 'waiting_for_output');
    await vi.advanceTimersByTimeAsync(30);
    expect(scope.signal.aborted).toBe(true);
  } finally {
    scope.dispose();
  }
});

it('cancels and disposes phase waits when the caller disconnects', async () => {
  const caller = new AbortController();
  const scope = new GenerationDeadlineScope(1000, caller.signal, policy);
  observeGenerationStreamProgress(scope.signal, 'thinking_only');
  caller.abort(new Error('Caller closed'));
  expect(scope.signal.reason).toBe(caller.signal.reason);
  scope.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
