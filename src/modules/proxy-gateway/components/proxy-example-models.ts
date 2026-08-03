import type { CloudAccount } from '@/modules/cloud-account/types';

export interface ProxyExampleModel {
  id: string;
  name: string;
}

export const FALLBACK_PROXY_EXAMPLE_MODELS: readonly ProxyExampleModel[] = [
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
  { id: 'gemini-3.5-flash-low', name: 'Gemini 3.5 Flash (Low)' },
  { id: 'gemini-3.5-flash-medium', name: 'Gemini 3.5 Flash (Medium)' },
  { id: 'gemini-3.5-flash-high', name: 'Gemini 3.5 Flash (High)' },
  { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)' },
  { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image' },
  { id: 'gemini-3-pro-image', name: 'Gemini 3 Pro Image' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-sonnet-4-6-thinking', name: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
];

type ProxyExampleAccount = Pick<CloudAccount, 'quota'>;

export function buildProxyExampleModels(
  accounts: readonly ProxyExampleAccount[],
): ProxyExampleModel[] {
  const modelsByNormalizedId = new Map<string, ProxyExampleModel>();

  for (const account of accounts) {
    for (const [rawModelId, info] of Object.entries(account.quota?.models ?? {})) {
      const modelId = rawModelId.replace(/^models\//i, '').trim();
      if (!modelId) {
        continue;
      }

      const normalizedId = modelId.toLowerCase();
      const displayName = info.display_name?.trim();
      const current = modelsByNormalizedId.get(normalizedId);
      if (!current || displayName) {
        modelsByNormalizedId.set(normalizedId, {
          id: current?.id ?? modelId,
          name: displayName || current?.name || modelId,
        });
      }
    }
  }

  for (const fallbackModel of FALLBACK_PROXY_EXAMPLE_MODELS) {
    const normalizedId = fallbackModel.id.toLowerCase();
    if (!modelsByNormalizedId.has(normalizedId)) {
      modelsByNormalizedId.set(normalizedId, fallbackModel);
    }
  }

  return [...modelsByNormalizedId.values()];
}

export function isImageProxyExampleModel(modelId: string): boolean {
  return modelId.toLowerCase().includes('image');
}
