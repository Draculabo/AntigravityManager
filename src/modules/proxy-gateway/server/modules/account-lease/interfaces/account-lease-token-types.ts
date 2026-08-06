import { isString } from 'lodash-es';
import type { CloudQuotaData } from '@/modules/cloud-account/types';

export interface AccountLeaseTokenData {
  email: string;
  account_id: string;
  access_token: string;
  refresh_token: string;
  id_token?: string;
  oauth_client_key?: string;
  token_type: string;
  expires_in: number;
  expiry_timestamp: number;
  project_id?: string;
  session_id?: string;
  upstream_proxy_url?: string;
  quota?: CloudQuotaData;
  model_quotas: Record<string, number>;
  model_limits: Record<string, number>;
  model_reset_times: Record<string, string>;
  model_forwarding_rules: Record<string, string>;
}

export function normalizeProjectId(projectId: string | null | undefined): string | undefined {
  if (!isString(projectId)) {
    return undefined;
  }

  const trimmedProjectId = projectId.trim();
  if (trimmedProjectId === '' || /^cloud-code-\d+$/i.test(trimmedProjectId)) {
    return undefined;
  }

  if (/^projects(?:\/.*)?$/i.test(trimmedProjectId)) {
    return undefined;
  }

  return trimmedProjectId;
}

export function normalizeModelId(modelId: string | null | undefined): string | undefined {
  if (!isString(modelId)) {
    return undefined;
  }
  const normalized = modelId.replace(/^models\//i, '').trim();
  return normalized !== '' ? normalized : undefined;
}

export function normalizeClientKey(clientKey: string | undefined): string | undefined {
  if (!isString(clientKey)) {
    return undefined;
  }
  const normalized = clientKey.trim().toLowerCase();
  return normalized !== '' ? normalized : undefined;
}
