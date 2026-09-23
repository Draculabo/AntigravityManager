import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clipboardWrite: vi.fn(),
  detail: vi.fn(),
  bodyContent: vi.fn(),
  loadConfig: vi.fn(),
  getServerConfig: vi.fn(),
  getStatus: vi.fn(),
}));

vi.mock('electron', () => ({ clipboard: { writeText: mocks.clipboardWrite } }));
vi.mock('@/modules/config/ipc/manager', () => ({
  ConfigManager: { loadConfig: mocks.loadConfig },
}));
vi.mock('@/server/main', () => ({ getNestServerStatus: mocks.getStatus }));
vi.mock('@/server/server-config', () => ({ getServerConfig: mocks.getServerConfig }));
vi.mock('@/modules/proxy-gateway/audit/traffic-audit.service', () => ({
  trafficAuditService: { detail: mocks.detail, bodyContent: mocks.bodyContent },
}));

import { copyAuditCurl } from '@/modules/proxy-gateway/traffic-monitor/copy-audit-curl';

describe('audit cURL clipboard boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({ proxy: { api_key: 'current-test-key', port: 8045 } });
    mocks.getServerConfig.mockReturnValue({ api_key: 'current-test-key' });
    mocks.getStatus.mockResolvedValue({ running: true, base_url: 'http://localhost:8045' });
    mocks.detail.mockResolvedValue({
      recordKind: 'request',
      request: {
        id: 'parent-1',
        method: 'POST',
        trafficClass: 'model',
        url: '/v1/responses',
        requestHeaders: JSON.stringify({
          authorization: '[REDACTED]',
          'content-type': 'application/json',
        }),
      },
      attempts: [],
      bodies: [],
    });
  });

  it('only writes the current key to the clipboard after explicit opt-in', async () => {
    await expect(
      copyAuditCurl({ id: 'parent-1', includeCredentials: false }),
    ).resolves.toBeUndefined();
    expect(mocks.clipboardWrite).toHaveBeenCalledWith(
      expect.not.stringContaining('current-test-key'),
    );

    await expect(
      copyAuditCurl({ id: 'parent-1', includeCredentials: true }),
    ).resolves.toBeUndefined();
    expect(mocks.clipboardWrite).toHaveBeenLastCalledWith(
      expect.stringContaining('current-test-key'),
    );
    expect(mocks.detail).toHaveBeenCalledWith('parent-1');
  });

  it('rejects credential export for upstream attempts before reading a record', async () => {
    await expect(
      copyAuditCurl({ id: 'parent-1', attemptId: 'attempt-1', includeCredentials: true }),
    ).rejects.toThrow('redacted credentials');
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.clipboardWrite).not.toHaveBeenCalled();
  });

  it('rejects stored headers that are not a JSON object before copying', async () => {
    mocks.detail.mockResolvedValue({
      recordKind: 'request',
      request: {
        id: 'parent-1',
        method: 'POST',
        trafficClass: 'model',
        url: '/v1/responses',
        requestHeaders: '[]',
      },
      attempts: [],
      bodies: [],
    });

    await expect(copyAuditCurl({ id: 'parent-1', includeCredentials: false })).rejects.toThrow();
    expect(mocks.clipboardWrite).not.toHaveBeenCalled();
  });
});
