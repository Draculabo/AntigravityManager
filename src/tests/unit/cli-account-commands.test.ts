import { describe, expect, it, vi } from 'vitest';
import { runCli } from '@/cli/app';
import type { AccountCommandClient } from '@/cli/account-commands';

function setup() {
  const output = { stdout: vi.fn(), stderr: vi.fn() };
  const launcher = { start: vi.fn(), stop: vi.fn(), status: vi.fn() };
  const client: AccountCommandClient = {
    accountViews: vi.fn(async () => []),
    switchCloudAccount: vi.fn(async () => undefined),
    accountSwitchStatus: vi.fn(),
    localAccounts: {
      listAccounts: vi.fn(async () => []),
      switchAccount: vi.fn(async () => undefined),
      getCurrentAccountInfo: vi.fn(async () => ({
        email: 'test@example.com',
        isAuthenticated: true,
      })),
      addAccountSnapshot: vi.fn(),
    },
  };
  return { output, launcher, client };
}

describe('CLI account commands', () => {
  it.each(['classic', 'ide', 'agy'])(
    'switches the selected cloud account in %s',
    async (target) => {
      const { output, launcher, client } = setup();
      expect(
        await runCli(
          ['account', 'switch', 'account-1', '--target', target],
          launcher,
          output,
          undefined,
          client,
        ),
      ).toBe(0);
      expect(launcher.start).toHaveBeenCalledOnce();
      expect(client.switchCloudAccount).toHaveBeenCalledExactlyOnceWith('account-1', target);
      expect(output.stdout).toHaveBeenCalledExactlyOnceWith(
        `Account switched successfully: ${target}\n`,
      );
    },
  );
  it.each(['classic', 'ide', 'agy'])('switches a local snapshot in %s', async (target) => {
    const { output, launcher, client } = setup();
    expect(
      await runCli(
        ['account', 'switch', 'snapshot-1', '--source', 'local', '--target', target],
        launcher,
        output,
        undefined,
        client,
      ),
    ).toBe(0);
    expect(client.localAccounts.switchAccount).toHaveBeenCalledExactlyOnceWith(
      'snapshot-1',
      target,
    );
    expect(client.switchCloudAccount).not.toHaveBeenCalled();
  });
  it('does not start or switch for an invalid target', async () => {
    const { output, launcher, client } = setup();
    expect(
      await runCli(
        ['account', 'switch', 'account-1', '--target', 'unknown'],
        launcher,
        output,
        undefined,
        client,
      ),
    ).toBe(2);
    expect(launcher.start).not.toHaveBeenCalled();
    expect(client.switchCloudAccount).not.toHaveBeenCalled();
  });
  it('does not announce success when switching fails', async () => {
    const { output, launcher, client } = setup();
    vi.mocked(client.switchCloudAccount).mockRejectedValue(
      new Error('Client could not be started.'),
    );
    expect(
      await runCli(['account', 'switch', 'account-1'], launcher, output, undefined, client),
    ).toBe(1);
    expect(output.stdout).not.toHaveBeenCalled();
    expect(output.stderr).toHaveBeenCalledExactlyOnceWith('Client could not be started.\n');
  });
  it('reads the actual selected client identity', async () => {
    const { output, launcher, client } = setup();
    expect(
      await runCli(['account', 'current', '--target', 'ide'], launcher, output, undefined, client),
    ).toBe(0);
    expect(client.localAccounts.getCurrentAccountInfo).toHaveBeenCalledExactlyOnceWith('ide');
    expect(JSON.parse(output.stdout.mock.calls[0][0])).toEqual({
      email: 'test@example.com',
      isAuthenticated: true,
    });
  });
});
