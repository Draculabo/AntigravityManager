import type { ImageQuotaRefresh } from './openai-operations.service';

let refresh: ImageQuotaRefresh | undefined;

/** The desktop supplies its monitor without adding Electron to the Nest import graph. */
export function configureImageQuotaRefresh(callback: ImageQuotaRefresh): void {
  refresh = callback;
}

export async function refreshImageQuota(): Promise<void> {
  await refresh?.();
}
