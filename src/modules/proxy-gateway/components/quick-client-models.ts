import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { isRetiredModel } from '../antigravity/retired-models';
import { isImageProxyExampleModel } from './proxy-example-models';

export function quickClientModels(accounts: readonly CloudAccountView[]): string[] {
  const models = new Set<string>();
  for (const account of accounts) {
    if (
      !account.proxy_enabled ||
      account.status_reason ||
      account.quota?.is_forbidden ||
      account.health?.oauth?.refresh_blocked ||
      account.health?.validation ||
      account.health?.service_disabled
    ) {
      continue;
    }
    for (const [name, quota] of Object.entries(account.quota?.models ?? {})) {
      const id = name.replace(/^models\//iu, '').trim();
      if (id && quota.percentage > 0 && !isRetiredModel(id) && !isImageProxyExampleModel(id)) {
        models.add(id);
      }
    }
  }
  const available = [...models].sort();
  const preferred = ['gemini-3.8-flash-high', 'gemini-3-flash', 'claude-sonnet-4-6-thinking'].find(
    (id) => models.has(id),
  );
  return preferred ? [preferred, ...available.filter((id) => id !== preferred)] : available;
}
