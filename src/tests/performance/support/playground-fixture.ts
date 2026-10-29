import {
  PlaygroundCompareInputSchema,
  type PlaygroundCompareInput,
  type PlaygroundExecuteInput,
  type PlaygroundExecuteResult,
} from '@/modules/proxy-gateway/playground/playground.schema';

let deferred = false;
let failAccount: string | null = null;
let sequence = 0;
let cancelled = 0;
const requests: PlaygroundExecuteInput[] = [];
const pending = new Map<number, () => void>();

function execute(input: PlaygroundExecuteInput, options?: { signal?: AbortSignal }) {
  requests.push(input);
  const failure = input.accountId === failAccount;
  const result: PlaygroundExecuteResult = {
    request: input,
    success: !failure,
    content: failure ? '' : 'Synthetic answer: ' + input.prompt,
    model: input.model,
    attributedAccountId: input.accountId,
    durationMs: 1000,
    status: failure ? 429 : 200,
    ...(failure ? { error: 'Synthetic account rate limit' } : {}),
  };
  if (!deferred) {
    return Promise.resolve(result);
  }
  return new Promise<PlaygroundExecuteResult>((resolve, reject) => {
    const id = ++sequence;
    const cleanup = () => {
      pending.delete(id);
      options?.signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      cancelled++;
      reject(new DOMException('Synthetic request cancelled', 'AbortError'));
    };
    pending.set(id, () => {
      cleanup();
      resolve(result);
    });
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) {
      abort();
    }
  });
}

export const playgroundFixture = {
  execute,
  compare: async (input: PlaygroundCompareInput, options?: { signal?: AbortSignal }) => {
    const { accountIds, ...parameters } = PlaygroundCompareInputSchema.parse(input);
    return {
      results: await Promise.all(
        accountIds.map((accountId) => execute({ ...parameters, accountId }, options)),
      ),
    };
  },
};

const controls = {
  setDeferred(value: boolean) {
    deferred = value;
  },
  setFailedAccount(id: string | null) {
    failAccount = id;
  },
  finish() {
    [...pending.values()].forEach((resolve) => resolve());
  },
  get pendingCount() {
    return pending.size;
  },
  get cancelledCount() {
    return cancelled;
  },
  get requests() {
    return requests;
  },
};

declare global {
  interface Window {
    __playgroundFixture: typeof controls;
  }
}
window.__playgroundFixture = controls;
