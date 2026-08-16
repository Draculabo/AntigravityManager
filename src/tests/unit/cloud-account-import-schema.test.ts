import { describe, expect, it } from 'vitest';
import { CloudAccountExportSchema } from '@/modules/cloud-account/types';

function buildExport(proxyUrl?: string | null) {
  return {
    version: '1.0' as const,
    exportedAt: Date.now(),
    accounts: [
      {
        provider: 'google' as const,
        email: 'user@example.com',
        proxy_url: proxyUrl,
      },
    ],
  };
}

describe('CloudAccountExportSchema proxy validation', () => {
  it.each([
    'http://127.0.0.1:8080',
    'https://proxy.example.com:8443',
    'socks5://127.0.0.1:1080',
  ])('accepts supported proxy URL %s', (proxyUrl) => {
    expect(CloudAccountExportSchema.safeParse(buildExport(proxyUrl)).success).toBe(true);
  });

  it.each(['not-a-url', 'ftp://proxy.example.com:21'])('rejects invalid proxy URL %s', (proxyUrl) => {
    expect(CloudAccountExportSchema.safeParse(buildExport(proxyUrl)).success).toBe(false);
  });

  it('continues to allow imports without an account proxy', () => {
    expect(CloudAccountExportSchema.safeParse(buildExport(undefined)).success).toBe(true);
    expect(CloudAccountExportSchema.safeParse(buildExport(null)).success).toBe(true);
  });
});
