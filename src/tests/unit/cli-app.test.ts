import { describe, expect, it, vi } from 'vitest';
import { runCli } from '@/cli/app';

function harness() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const launcher = {
    status: vi.fn().mockResolvedValue(null),
    start: vi.fn(),
    stop: vi.fn(),
  };
  return {
    stdout,
    stderr,
    launcher,
    output: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

describe('Node CLI', () => {
  it('shows package-generated help and marks absent service with a stable exit code', async () => {
    const test = harness();
    expect(await runCli(['--help'], test.launcher, test.output)).toBe(0);
    expect(test.stdout.join('')).toContain('service');

    test.stdout.length = 0;
    expect(await runCli(['service', 'status'], test.launcher, test.output)).toBe(3);
    expect(test.stdout).toEqual(['stopped\n']);
  });

  it('prints service start and stop results to stdout', async () => {
    const test = harness();
    test.launcher.start.mockResolvedValue({ status: { pid: 123 }, alreadyRunning: false });
    test.launcher.stop.mockResolvedValue({ alreadyStopped: false });

    expect(await runCli(['service', 'start'], test.launcher, test.output)).toBe(0);
    expect(await runCli(['service', 'stop'], test.launcher, test.output)).toBe(0);
    expect(test.stdout).toEqual(['started pid=123\n', 'stopped\n']);
    expect(test.stderr).toEqual([]);
  });

  it('sends operational errors to stderr with a nonzero exit code', async () => {
    const test = harness();
    test.launcher.start.mockRejectedValue(new Error('startup timed out'));

    expect(await runCli(['service', 'start'], test.launcher, test.output)).toBe(1);
    expect(test.stderr).toEqual(['startup timed out\n']);
    expect(test.stdout).toEqual([]);
  });

  it('prints a browser URL and a safe account summary after headless login', async () => {
    const test = harness();
    test.launcher.start.mockResolvedValue({ status: { pid: 123 }, alreadyRunning: false });
    const oauth = {
      startOAuth: vi.fn().mockResolvedValue({
        sessionId: '11111111-1111-4111-8111-111111111111',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
      }),
      oauthStatus: vi.fn().mockResolvedValue({
        state: 'succeeded',
        account: { id: '22222222-2222-4222-8222-222222222222', email: 'example@example.com' },
      }),
    };

    expect(await runCli(['account', 'login'], test.launcher, test.output, oauth)).toBe(0);
    expect(test.stdout).toEqual([
      'Open this URL in a browser on this machine:\nhttps://accounts.google.com/o/oauth2/v2/auth?client_id=test\n',
      'Google account added: example@example.com\n',
    ]);
    expect(test.stdout.join('')).not.toContain('access_token');
    expect(test.stderr).toEqual([]);
  });

  it('does not advertise unsupported custom OAuth client selection', async () => {
    const test = harness();
    expect(await runCli(['account', 'login', '--help'], test.launcher, test.output)).toBe(0);
    expect(test.stdout.join('')).not.toContain('--client');
  });
});
