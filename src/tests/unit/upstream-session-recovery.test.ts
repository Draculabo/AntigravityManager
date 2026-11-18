import { describe, expect, it, vi } from 'vitest';
import {
  UpstreamSessionRecovery,
  isUpstreamInputLimitError,
} from '@/server/gateway/common/upstream-session-recovery';
import {
  createUpstreamSessionIdentity,
  type UpstreamSessionIdentity,
} from '@/server/gateway/common/upstream-session-identity';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';

const identity = createUpstreamSessionIdentity('account-a', 'store-a');
const overflow = () =>
  new UpstreamRequestError({
    status: 400,
    message: 'The input token count exceeds the maximum number of tokens allowed 1048576',
  });
const recover = (state: UpstreamSessionRecovery, base = identity, accountId?: string) =>
  state.execute({
    accountId,
    identity: base,
    canRecover: () => true,
    timeoutMs: 1000,
    initial: async () => {
      throw overflow();
    },
    recover: async (admit) => admit().identity,
  });

describe('bounded upstream context recovery state', () => {
  it('forgets only the deleted account and starts its re-added identity at generation zero', async () => {
    const state = new UpstreamSessionRecovery();
    const aOther = createUpstreamSessionIdentity('account-a', 'store-b');
    const b = createUpstreamSessionIdentity('account-b', 'store-a');
    await recover(state, identity, 'account-a');
    await recover(state, aOther, 'account-a');
    const bRecovered = await recover(state, b, 'account-b');
    expect(state.size).toBe(3);
    state.forgetAccount('missing');
    expect(state.size).toBe(3);
    state.forgetAccount('account-a');
    expect(state.size).toBe(1);
    const read = (base: UpstreamSessionIdentity, accountId: string) =>
      state.execute({
        accountId,
        identity: base,
        canRecover: () => true,
        timeoutMs: 1000,
        initial: async (current) => current,
        recover: async () => {
          throw new Error('Unexpected recovery');
        },
      });
    expect(await read(b, 'account-b')).toEqual(bRecovered);
    expect(await read(identity, 'account-a')).toEqual(identity);
  });

  it('does not let a deleted in-flight frame overwrite a re-added account record', async () => {
    const state = new UpstreamSessionRecovery();
    let rejectInitial!: (error: Error) => void;
    const initial = new Promise<UpstreamSessionIdentity>((_resolve, reject) => {
      rejectInitial = reject;
    });
    const resend = vi.fn(
      async (admit: () => { identity: UpstreamSessionIdentity }) => admit().identity,
    );
    const pending = state.execute({
      accountId: 'account-a',
      identity,
      canRecover: () => true,
      timeoutMs: 1000,
      initial: () => initial,
      recover: resend,
    });
    state.forgetAccount('account-a');
    const replacement = await recover(state, identity, 'account-a');
    const original = overflow();
    const rejection = expect(pending).rejects.toBe(original);
    rejectInitial(original);
    await rejection;
    const current = await state.execute({
      accountId: 'account-a',
      identity,
      canRecover: () => true,
      timeoutMs: 1000,
      initial: async (value) => value,
      recover: async () => {
        throw new Error('Unexpected recovery');
      },
    });
    expect(current).toEqual(replacement);
    expect(state.size).toBe(1);
  });

  it('does not admit recovery metadata when the captured lease is already ineligible', async () => {
    const state = new UpstreamSessionRecovery();
    const resend = vi.fn();
    await expect(
      state.execute({
        accountId: 'account-a',
        identity,
        canRecover: () => false,
        timeoutMs: 1000,
        initial: async () => {
          throw overflow();
        },
        recover: resend,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(state.size).toBe(0);
    expect(resend).not.toHaveBeenCalled();
  });

  it('keeps generation zero stable and scopes replacements by account and store', async () => {
    const state = new UpstreamSessionRecovery();
    expect(
      await state.execute({
        identity,
        canRecover: () => true,
        timeoutMs: 1000,
        initial: async (current) => current,
        recover: async () => {
          throw new Error('Unexpected recovery');
        },
      }),
    ).toEqual(identity);
    const replacement = await recover(state);
    expect(replacement.sessionId).not.toBe(identity.sessionId);
    expect(replacement.conversationId).toBe(identity.conversationId);
    expect(BigInt(replacement.sessionId)).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(BigInt(replacement.sessionId)).toBeLessThan(2n ** 63n);
    const seen: Array<UpstreamSessionIdentity | undefined> = [];
    for (const base of [
      identity,
      createUpstreamSessionIdentity('account-b', 'store-a'),
      createUpstreamSessionIdentity('account-a', 'store-b'),
    ]) {
      await state.execute({
        identity: base,
        canRecover: () => true,
        timeoutMs: 1000,
        initial: async (current) => {
          seen.push(current);
        },
        recover: async () => undefined,
      });
    }
    expect(seen).toEqual([
      replacement,
      createUpstreamSessionIdentity('account-b', 'store-a'),
      createUpstreamSessionIdentity('account-a', 'store-b'),
    ]);
  });

  it.each([
    new UpstreamRequestError({ status: 400, message: 'Invalid thought signature' }),
    new UpstreamRequestError({
      status: 400,
      message: 'Output token count exceeds the maximum number of tokens',
    }),
    new UpstreamRequestError({ status: 413, message: overflow().message }),
    new Error(overflow().message),
  ])('does not recover unrecognized errors: $message', async (error) => {
    const retry = vi.fn();
    await expect(
      new UpstreamSessionRecovery().execute({
        identity,
        canRecover: () => true,
        timeoutMs: 1000,
        initial: async () => {
          throw error;
        },
        recover: retry,
      }),
    ).rejects.toBe(error);
    expect(retry).not.toHaveBeenCalled();
    expect(isUpstreamInputLimitError(error)).toBe(false);
  });

  it('merges concurrent failures of the same generation into one replacement', async () => {
    const state = new UpstreamSessionRecovery();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = () =>
      state.execute({
        identity,
        canRecover: () => true,
        timeoutMs: 1000,
        initial: async () => {
          await barrier;
          throw overflow();
        },
        recover: async (admit) => admit().identity,
      });
    const first = run();
    const second = run();
    release();
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).not.toEqual(identity);
    expect(state.size).toBe(1);
  });

  it('bounds inactive identities and never recreates an expired or evicted in-flight handle', async () => {
    let now = 0;
    const state = new UpstreamSessionRecovery({ capacity: 2, ttlMs: 10, clock: () => now });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn();
    const pending = state.execute({
      identity,
      canRecover: () => true,
      timeoutMs: 1000,
      initial: async () => {
        await barrier;
        throw overflow();
      },
      recover: async (admit) => {
        const result = admit();
        send();
        return result.identity;
      },
    });
    await recover(state, createUpstreamSessionIdentity('b', 'b'));
    await recover(state, createUpstreamSessionIdentity('c', 'c'));
    release();
    await expect(pending).rejects.toMatchObject({ status: 400 });
    expect(state.size).toBe(2);
    expect(send).not.toHaveBeenCalled();
    now = 10;
    expect(state.size).toBe(0);
    const replacement = await recover(state);
    now = 20;
    expect(state.size).toBe(0);
    expect((await recover(state)).sessionId).not.toBe(replacement.sessionId);
  });

  it.each(['cancel', 'lease', 'deadline'] as const)(
    'rechecks %s immediately before the physical resend and leaves identity unchanged',
    async (mode) => {
      let now = 0;
      const state = new UpstreamSessionRecovery({ clock: () => now });
      const abort = new AbortController();
      let eligible = true;
      const error = overflow();
      const send = vi.fn();
      await expect(
        state.execute({
          identity,
          signal: abort.signal,
          canRecover: () => eligible,
          timeoutMs: 100,
          initial: async () => {
            throw error;
          },
          recover: async (admit) => {
            if (mode === 'cancel') {
              abort.abort();
            }
            if (mode === 'lease') {
              eligible = false;
            }
            if (mode === 'deadline') {
              now = 100;
            }
            admit();
            send();
          },
        }),
      ).rejects.toBe(error);
      expect(send).not.toHaveBeenCalled();
      expect(
        await state.execute({
          identity,
          canRecover: () => true,
          timeoutMs: 100,
          initial: async (current) => current,
          recover: async () => undefined,
        }),
      ).toEqual(identity);
    },
  );

  it('preserves both failure diagnostics and only admits one additional send', async () => {
    const first = overflow();
    const second = new UpstreamRequestError({ status: 400, message: 'Still too large' });
    const state = new UpstreamSessionRecovery();
    await expect(
      state.execute({
        identity,
        canRecover: () => true,
        timeoutMs: 1000,
        initial: async () => {
          throw first;
        },
        recover: async (admit) => {
          admit();
          throw second;
        },
      }),
    ).rejects.toBe(second);
    expect(second.cause).toBe(first);
    const original = overflow();
    await expect(
      state.execute({
        identity,
        canRecover: () => true,
        timeoutMs: 1000,
        initial: async () => {
          throw original;
        },
        recover: async (admit) => {
          admit();
          admit();
        },
      }),
    ).rejects.toBe(original);
    expect(original.cause).toBeUndefined();
  });

  it('does not enable implicit recovery without a lease owner and accounts for elapsed preparation time', async () => {
    const state = new UpstreamSessionRecovery();
    const retry = vi.fn();
    await expect(
      state.execute({
        identity,
        timeoutMs: 100,
        initial: async () => {
          throw overflow();
        },
        recover: retry,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(retry).not.toHaveBeenCalled();
    let now = 0;
    const timed = new UpstreamSessionRecovery({ clock: () => now });
    const result = await timed.execute({
      identity,
      canRecover: () => true,
      timeoutMs: 100,
      initial: async () => {
        now = 60;
        throw overflow();
      },
      recover: async (admit) => admit(),
    });
    expect(result.timeoutMs).toBe(40);
  });

  it('shares the one-send budget across account fallbacks of one logical request', async () => {
    const state = new UpstreamSessionRecovery();
    const budget = { attempted: false };
    const send = vi.fn();
    for (const base of [identity, createUpstreamSessionIdentity('other-account', 'store-a')]) {
      await state
        .execute({
          identity: base,
          budget,
          canRecover: () => true,
          timeoutMs: 1000,
          initial: async () => {
            throw overflow();
          },
          recover: async (admit) => {
            admit();
            send();
          },
        })
        .catch((error) => {
          expect(error).toBeInstanceOf(UpstreamRequestError);
        });
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(budget.attempted).toBe(true);
  });

  it('does not revive an expired in-flight identity while the request deadline is still live', async () => {
    let now = 0;
    const state = new UpstreamSessionRecovery({ ttlMs: 5, clock: () => now });
    const original = overflow();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn();
    const pending = state.execute({
      identity,
      canRecover: () => true,
      timeoutMs: 1000,
      initial: async () => {
        await barrier;
        throw original;
      },
      recover: async (admit) => {
        admit();
        send();
      },
    });
    now = 5;
    release();
    await expect(pending).rejects.toBe(original);
    expect(send).not.toHaveBeenCalled();
    expect(state.size).toBe(0);
  });
});
