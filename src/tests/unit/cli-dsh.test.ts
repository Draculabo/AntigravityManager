import { ORPCError } from '@orpc/client';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '@/cli/app';
import type { AgentToolsCommandClient } from '@/cli/agent-tools-commands';
import type { DshOperations } from '@/modules/proxy-gateway/dsh-sync/dsh-owner.service';

const profile = 'local-dev';
const profileFlags = ['--profile', profile];
const baseUrl = 'http://127.0.0.1:8045/v1';
const credentialRef = 'DSH_MANAGER_KEY';
const syncFlags = [
  '--protocol',
  'openai-responses',
  '--base-url',
  baseUrl,
  '--credential-ref',
  credentialRef,
  '--model',
  'first-model',
  '--model',
  'second-model',
];
const sourceHash = 'a'.repeat(64);
const mutationFlags = ['--source-hash', sourceHash, '--yes'];
const patchPath = 'profiles/local-dev/cordis.patch.yml';
const syncPlan = {
  profile,
  action: 'sync',
  protocol: 'openai-responses',
  baseUrl,
  credentialRef,
  models: ['first-model', 'second-model'],
};
const syncPreview = {
  patchPath,
  action: 'sync',
  providerId: 'antigravity-manager',
  changed: true,
  sourceHash,
  protocol: 'openai-responses',
  baseUrl,
  credentialRef,
  models: ['first-model', 'second-model'],
  credentialAction: 'preserve',
  defaultAction: 'preserve',
  defaultModel: null,
} satisfies Awaited<ReturnType<DshOperations['preview']>>;
const writeResult = {
  patchPath,
  sourceHash: 'b'.repeat(64),
  changed: true,
  restartRequired: false,
} satisfies Awaited<ReturnType<DshOperations['sync']>>;
const secret = 'fixture-private-secret';

function setup() {
  const output = { stdout: vi.fn(), stderr: vi.fn() };
  const launcher = { start: vi.fn(), stop: vi.fn(), status: vi.fn() };
  const dsh = {
    status: vi.fn<DshOperations['status']>(),
    preview: vi.fn<DshOperations['preview']>(),
    sync: vi.fn<DshOperations['sync']>(),
    remove: vi.fn<DshOperations['remove']>(),
  };
  const client: AgentToolsCommandClient = {
    agentTools: {
      status: vi.fn(),
      configure: vi.fn(),
      preview: vi.fn(),
      restore: vi.fn(),
      remove: vi.fn(),
    },
    openCode: {
      status: vi.fn(),
      sync: vi.fn(),
      restore: vi.fn(),
      clear: vi.fn(),
      preview: vi.fn(),
      revokeKey: vi.fn(),
    },
    dsh,
  };
  const run = (...args: string[]) =>
    runCli(['tools', 'dsh', ...args], launcher, output, undefined, undefined, client);
  return { dsh, launcher, output, run };
}

describe('CLI DSH configuration', () => {
  it('prints status for the explicit profile as JSON', async () => {
    const { dsh, launcher, output, run } = setup();
    const result = { patchPath, exists: false, sourceHash: null };
    dsh.status.mockResolvedValue(result);

    expect(await run('status', ...profileFlags)).toBe(0);

    expect(launcher.start).toHaveBeenCalledExactlyOnceWith();
    expect(dsh.status).toHaveBeenCalledExactlyOnceWith({ profile });
    expect(output.stdout).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify(result)}\n`);
    expect(output.stderr).not.toHaveBeenCalled();
  });

  it('previews sync with repeated models and owner defaults', async () => {
    const { dsh, output, run } = setup();
    dsh.preview.mockResolvedValue(syncPreview);

    expect(await run('preview', ...profileFlags, '--action', 'sync', ...syncFlags)).toBe(0);

    expect(dsh.preview).toHaveBeenCalledExactlyOnceWith({
      ...syncPlan,
      credentialMode: 'existing-reference',
      activateModel: null,
    });
    expect(output.stdout).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify(syncPreview)}\n`);
    expect(dsh.sync).not.toHaveBeenCalled();
    expect(dsh.remove).not.toHaveBeenCalled();
  });

  it('previews removal without passing connection settings', async () => {
    const { dsh, output, run } = setup();
    const result = {
      ...syncPreview,
      action: 'remove',
      protocol: null,
      baseUrl: null,
      credentialRef: null,
      models: [],
      credentialAction: 'remove',
    } satisfies Awaited<ReturnType<DshOperations['preview']>>;
    dsh.preview.mockResolvedValue(result);

    expect(await run('preview', ...profileFlags, '--action', 'remove')).toBe(0);

    expect(dsh.preview).toHaveBeenCalledExactlyOnceWith({ profile, action: 'remove' });
    expect(output.stdout).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify(result)}\n`);
    expect(dsh.remove).not.toHaveBeenCalled();
  });

  it('applies a reviewed sync with the selected credential and default model', async () => {
    const { dsh, output, run } = setup();
    dsh.sync.mockResolvedValue(writeResult);

    expect(
      await run(
        'apply',
        ...profileFlags,
        ...syncFlags,
        ...mutationFlags,
        '--activate-model',
        'second-model',
        '--credential-mode',
        'manager-key',
      ),
    ).toBe(0);

    expect(dsh.sync).toHaveBeenCalledExactlyOnceWith({
      ...syncPlan,
      expectedSourceHash: sourceHash,
      credentialMode: 'manager-key',
      activateModel: 'second-model',
    });
    expect(output.stdout).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify(writeResult)}\n`);
  });

  it('removes only the reviewed profile', async () => {
    const { dsh, output, run } = setup();
    dsh.remove.mockResolvedValue(writeResult);

    expect(await run('remove', ...profileFlags, ...mutationFlags)).toBe(0);

    expect(dsh.remove).toHaveBeenCalledExactlyOnceWith({ profile, expectedSourceHash: sourceHash });
    expect(output.stdout).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify(writeResult)}\n`);
  });

  it.each([
    ['missing profile', ['status']],
    ['path traversal', ['status', '--profile', '../other']],
    ['missing preview action', ['preview', ...profileFlags]],
    ['unsupported preview action', ['preview', ...profileFlags, '--action', secret]],
    [
      'sync flags on remove preview',
      ['preview', ...profileFlags, '--action', 'remove', ...syncFlags],
    ],
    ['missing sync settings', ['preview', ...profileFlags, '--action', 'sync']],
    [
      'unsupported protocol',
      ['preview', ...profileFlags, '--action', 'sync', ...syncFlags, '--protocol', secret],
    ],
    [
      'URL with credentials',
      [
        'preview',
        ...profileFlags,
        '--action',
        'sync',
        ...syncFlags,
        '--base-url',
        `https://user:${secret}@example.test`,
      ],
    ],
    [
      'bad credential reference',
      ['preview', ...profileFlags, '--action', 'sync', ...syncFlags, '--credential-ref', secret],
    ],
    [
      'bad credential mode',
      ['preview', ...profileFlags, '--action', 'sync', ...syncFlags, '--credential-mode', secret],
    ],
    [
      'unlisted default model',
      ['preview', ...profileFlags, '--action', 'sync', ...syncFlags, '--activate-model', secret],
    ],
    [
      'model flag without a value',
      ['preview', ...profileFlags, '--model', '--action', 'sync', ...syncFlags],
    ],
    [
      'activation flag without a value',
      ['preview', ...profileFlags, '--activate-model', '--action', 'sync', ...syncFlags],
    ],
    [
      'model flag followed by an unknown flag',
      [
        'preview',
        ...profileFlags,
        '--action',
        'sync',
        ...syncFlags,
        '--model',
        `--credential=${secret}`,
      ],
    ],
    [
      'apply without confirmation',
      ['apply', ...profileFlags, ...syncFlags, '--source-hash', sourceHash],
    ],
    ['apply without review hash', ['apply', ...profileFlags, ...syncFlags, '--yes']],
    ['remove without confirmation', ['remove', ...profileFlags, '--source-hash', sourceHash]],
    ['invalid source hash', ['remove', ...profileFlags, '--yes', '--source-hash', secret]],
    ['sync flags on remove', ['remove', ...profileFlags, ...mutationFlags, ...syncFlags]],
    ['unknown flag', ['status', ...profileFlags, `--credential=${secret}`]],
    ['unexpected argument', ['status', ...profileFlags, secret]],
  ])('rejects %s before starting Core', async (_, args) => {
    const { dsh, launcher, output, run } = setup();

    expect(await run(...args)).not.toBe(0);

    expect(launcher.start).not.toHaveBeenCalled();
    expect(dsh.status).not.toHaveBeenCalled();
    expect(dsh.preview).not.toHaveBeenCalled();
    expect(dsh.sync).not.toHaveBeenCalled();
    expect(dsh.remove).not.toHaveBeenCalled();
    expect(output.stdout).not.toHaveBeenCalled();
    expect(output.stderr).toHaveBeenCalled();
    expect(output.stderr.mock.calls.flat().join('')).not.toContain(secret);
  });

  it.each([
    ['conflict', 'Review a fresh preview before retrying.'],
    [
      'receipt-failed',
      'DSH settings may have changed. Inspect the profile and its credentials before retrying.',
    ],
    [secret, 'Check the current DSH settings before retrying.'],
  ])('maps the owner error %s to safe recovery guidance', async (dshCode, hint) => {
    const { dsh, output, run } = setup();
    dsh.remove.mockRejectedValue(
      new ORPCError('SERVICE_UNAVAILABLE', {
        message: secret,
        data: { dshCode },
      }),
    );

    expect(await run('remove', ...profileFlags, ...mutationFlags)).toBe(1);

    const code = dshCode === secret ? 'operation-failed' : dshCode;
    expect(output.stdout).not.toHaveBeenCalled();
    expect(output.stderr).toHaveBeenCalledExactlyOnceWith(
      `DSH operation failed (${code}). ${hint}\n`,
    );
  });

  it('rejects unexpected result fields without printing the result', async () => {
    const { dsh, output, run } = setup();
    const result = { patchPath, exists: true, sourceHash, contents: secret };
    dsh.status.mockResolvedValue(result);

    expect(await run('status', ...profileFlags)).toBe(1);

    expect(output.stdout).not.toHaveBeenCalled();
    expect(output.stderr).toHaveBeenCalledExactlyOnceWith(
      'DSH operation failed (operation-failed). Check the current DSH settings before retrying.\n',
    );
  });

  it('omits details from a Core startup failure', async () => {
    const { dsh, launcher, output, run } = setup();
    launcher.start.mockRejectedValue(new Error(secret));

    expect(await run('status', ...profileFlags)).toBe(1);

    expect(dsh.status).not.toHaveBeenCalled();
    expect(output.stdout).not.toHaveBeenCalled();
    expect(output.stderr).toHaveBeenCalledExactlyOnceWith(
      'Could not start or connect to the standalone Manager Core. Check service status and profile ownership.\n',
    );
  });
});
