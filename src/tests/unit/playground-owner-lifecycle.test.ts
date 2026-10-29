import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { playgroundService } from '@/modules/proxy-gateway/playground/playground.service';
import type { PlaygroundExecuteResult } from '@/modules/proxy-gateway/playground/playground.schema';

afterEach(() => vi.restoreAllMocks());

describe('Playground core ownership', () => {
  it('drains admitted generation and refuses new work during core shutdown', async () => {
    let finish!: (result: PlaygroundExecuteResult) => void;
    const pending = new Promise<PlaygroundExecuteResult>((resolve) => {
      finish = resolve;
    });
    const execute = vi.spyOn(playgroundService, 'execute').mockReturnValue(pending);
    const operations = createCoreRpcOperations({ startGateway: vi.fn(), stopGateway: vi.fn() });
    const input = { model: 'gemini-3-flash', prompt: 'Hi' };
    const execution = operations.playground.execute(input);
    operations.closeAccountMutationAdmission();
    let drained = false;
    const draining = operations.drainAccountMutations().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(operations.playground.execute(input)).rejects.toThrow('shutting down');
    await expect(operations.playground.compare({ ...input, accountIds: ['a'] })).rejects.toThrow(
      'shutting down',
    );
    const result: PlaygroundExecuteResult = {
      success: true,
      content: 'Completed',
      model: input.model,
      durationMs: 1000,
      status: 200,
    };
    finish(result);
    expect(await execution).toEqual(result);
    await draining;
    expect(drained).toBe(true);
    expect(execute).toHaveBeenCalledExactlyOnceWith(input, undefined);
  });
});
