export function throwIfRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Upstream request cancelled', 'AbortError');
  }
}

/** Detaches a request waiter; the underlying operation must own its cancellation separately. */
export function awaitRequestOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return operation;
  }
  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      reject(new DOMException('Upstream request cancelled', 'AbortError'));
    };
    operation.then(
      (value) => {
        signal.removeEventListener('abort', cancel);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      },
    );
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) {
      cancel();
    }
  });
}
