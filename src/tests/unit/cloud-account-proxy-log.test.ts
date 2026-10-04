import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { logger } from '@/shared/logging/logger';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(),
}));

vi.mock('@/modules/cloud-account/persistence/cloud-account-db', () => ({
  getCloudDb: () => ({
    raw: { close: mocks.close },
    orm: {
      update: () => ({ set: () => ({ where: () => ({ run: mocks.run }) }) }),
    },
  }),
}));
vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const accountId = '11111111-1111-4111-8111-111111111111';
const proxyUrl = 'http://proxy-user:proxy-password@127.0.0.1:7890';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cloud account proxy logging', () => {
  it('records only configured or removed state after a successful write', () => {
    CloudAccountRepo.setAccountProxy(accountId, proxyUrl);
    CloudAccountRepo.setAccountProxy(accountId, null);

    expect(vi.mocked(logger.info).mock.calls).toEqual([
      [`Updated proxy for account ${accountId}: configured`],
      [`Updated proxy for account ${accountId}: removed`],
    ]);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(proxyUrl);
  });

  it('returns and logs a value-free error when the write fails', () => {
    mocks.run.mockImplementationOnce(() => {
      throw new Error(`Database rejected ${proxyUrl}`);
    });

    expect(() => CloudAccountRepo.setAccountProxy(accountId, proxyUrl)).toThrow(
      'Failed to update account proxy',
    );
    expect(vi.mocked(logger.error).mock.calls).toEqual([
      [`Failed to update proxy for account ${accountId}`],
    ]);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(proxyUrl);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
