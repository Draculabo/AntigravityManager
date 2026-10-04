import { describe, expect, it, vi } from 'vitest';
import {
  drainDesktopCloudAccountSwitches,
  switchCloudAccountForDesktop,
} from '@/modules/cloud-account/ipc/cloud-account-switch-desktop';
import { switchCloudAccountCore } from '@/modules/cloud-account/services/cloud-account-switch.service';

vi.mock('@/modules/cloud-account/services/cloud-account-switch.service', () => ({
  switchCloudAccountCore: vi.fn(),
}));
vi.mock('@/modules/cloud-account/ipc/quota-refresh-desktop', () => ({
  notifyTrayUpdate: vi.fn(),
}));

describe('desktop cloud account switch admission', () => {
  it('drains admitted work and rejects new switches during quit', async () => {
    let finishSwitch: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finishSwitch = resolve;
    });
    vi.mocked(switchCloudAccountCore).mockReturnValueOnce(pending);

    const switching = switchCloudAccountForDesktop('account-1', 'ide');
    let drained = false;
    const draining = drainDesktopCloudAccountSwitches().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(switchCloudAccountForDesktop('account-2')).rejects.toMatchObject({
      switchCode: 'switch-failed',
    });
    expect(switchCloudAccountCore).toHaveBeenCalledTimes(1);

    finishSwitch();
    await Promise.all([switching, draining]);
    expect(drained).toBe(true);
  });
});
