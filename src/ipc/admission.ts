import { ORPCError } from '@orpc/server';

/** Renderer admission closes before teardown; accepted handlers finish before owner detachment. */
export function createDesktopRpcAdmission() {
  let accepting = true;
  const pending = new Set<Promise<void>>();
  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (!accepting) {
        throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'Desktop is shutting down' });
      }
      let release: () => void = () => {};
      const admitted = new Promise<void>((resolve) => {
        release = resolve;
      });
      pending.add(admitted);
      try {
        return await work();
      } finally {
        release();
        pending.delete(admitted);
      }
    },
    close() {
      accepting = false;
    },
    async drain() {
      await Promise.all([...pending]);
    },
  };
}
export const desktopRpcAdmission = createDesktopRpcAdmission();
