import { expect, it, vi } from 'vitest';
import {
  runWithSwitchGuard,
  getSwitchGuardSnapshot,
} from '@/modules/antigravity-runtime/switch/switchGuard';
import { getProcessOperation, reserveSwitch } from '@/modules/antigravity-runtime/operation';

vi.mock('@/shared/logging/logger', () => ({ logger: { info: vi.fn() } }));

it('rejects switches across owners and targets while one operation owns shared credentials', async () => {
  let release!: () => void;
  const blocker = new Promise<string>((resolve) => {
    release = () => resolve('completed');
  });
  const first = runWithSwitchGuard('local-account-switch', () => blocker, 'classic');
  const rejectedAction = vi.fn(async () => {});
  try {
    expect(getProcessOperation('classic')).toBe('switching');
    for (const target of ['classic', 'ide', 'agy'] as const) {
      await expect(
        runWithSwitchGuard('cloud-account-switch', rejectedAction, target),
      ).rejects.toMatchObject({ messageKey: 'process-runtime.busy' });
    }
    expect(getSwitchGuardSnapshot()).toEqual({ activeOwner: 'local-account-switch' });
  } finally {
    release();
    await expect(first).resolves.toBe('completed');
  }
  expect(rejectedAction).not.toHaveBeenCalled();
  expect(getSwitchGuardSnapshot()).toEqual({ activeOwner: null });
  expect(getProcessOperation('classic')).toBe('idle');
  await expect(
    runWithSwitchGuard('cloud-account-switch', async () => 'retry', 'ide'),
  ).resolves.toBe('retry');
});

it('releases global and target ownership after a failed switch', async () => {
  await expect(
    runWithSwitchGuard(
      'cloud-account-switch',
      async () => {
        throw new Error('switch failed');
      },
      'classic',
    ),
  ).rejects.toThrow('switch failed');
  expect(getSwitchGuardSnapshot()).toEqual({ activeOwner: null });
  expect(getProcessOperation('classic')).toBe('idle');
  await expect(
    runWithSwitchGuard('local-account-switch', async () => 'retry', 'agy'),
  ).resolves.toBe('retry');
});

it('does not acquire global ownership when the selected target is already reserved', async () => {
  const release = reserveSwitch('classic');
  const action = vi.fn(async () => {});
  try {
    await expect(
      runWithSwitchGuard('local-account-switch', action, 'classic'),
    ).rejects.toMatchObject({
      messageKey: 'process-runtime.busy',
    });
    expect(getSwitchGuardSnapshot()).toEqual({ activeOwner: null });
  } finally {
    release();
  }
  expect(action).not.toHaveBeenCalled();
});
