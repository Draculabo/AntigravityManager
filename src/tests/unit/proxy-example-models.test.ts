import { describe, expect, it } from 'vitest';
import type { CloudQuotaModelInfo } from '@/modules/cloud-account/types';
import {
  FALLBACK_PROXY_EXAMPLE_MODELS,
  buildProxyExampleModels,
  isImageProxyExampleModel,
} from '@/modules/proxy-gateway/components/proxy-example-models';

function quota(displayName?: string): CloudQuotaModelInfo {
  return {
    percentage: 100,
    resetTime: '',
    display_name: displayName,
  };
}

describe('proxy example models', () => {
  it('keeps dynamic quota models first, normalizes prefixes, and deduplicates ids', () => {
    const models = buildProxyExampleModels([
      {
        quota: {
          models: {
            'models/vendor-preview': quota(),
            'gemini-3-flash': quota(),
          },
        },
      },
      {
        quota: {
          models: {
            'VENDOR-PREVIEW': quota('Vendor Preview'),
          },
        },
      },
    ]);

    expect(models).toEqual([
      { id: 'vendor-preview', name: 'Vendor Preview' },
      { id: 'gemini-3-flash', name: 'gemini-3-flash' },
      ...FALLBACK_PROXY_EXAMPLE_MODELS.filter((model) => model.id !== 'gemini-3-flash'),
    ]);
  });

  it('uses the complete fallback list when no account quota is available', () => {
    expect(buildProxyExampleModels([])).toEqual(FALLBACK_PROXY_EXAMPLE_MODELS);
  });

  it('detects image variants without depending on a fixed suffix', () => {
    expect([
      isImageProxyExampleModel('gemini-3-pro-image'),
      isImageProxyExampleModel('gemini-3-pro-image-4k-16x9'),
      isImageProxyExampleModel('gemini-3.5-flash-high'),
    ]).toEqual([true, true, false]);
  });
});
