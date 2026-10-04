import { describe, expect, it, vi } from 'vitest';
import { runCli } from '@/cli/app';
import type { AgentToolsCommandClient } from '@/cli/agent-tools-commands';

function setup() {
  const output = { stdout: vi.fn(), stderr: vi.fn() };
  const launcher = { start: vi.fn(), stop: vi.fn(), status: vi.fn() };
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
  };
  const run = (args: string[]) => runCli(args, launcher, output, undefined, undefined, client);
  return { output, launcher, client, run };
}
describe('CLI coding tool configuration', () => {
  it.each(['claude', 'codex', 'opencode'])('configures %s through its owner', async (tool) => {
    const { client, launcher, output, run } = setup();
    const baseUrl = 'http://127.0.0.1:8045/v1';
    const model = 'gemini-3.1-pro-high';
    expect(await run(['tools', 'configure', tool, '--base-url', baseUrl, '--model', model])).toBe(
      0,
    );
    expect(launcher.start).toHaveBeenCalledOnce();
    if (tool === 'opencode') {
      expect(client.openCode.sync).toHaveBeenCalledExactlyOnceWith({
        baseUrl,
        models: [{ id: model }],
      });
      expect(client.agentTools.configure).not.toHaveBeenCalled();
    } else {
      expect(client.agentTools.configure).toHaveBeenCalledExactlyOnceWith({ tool, baseUrl, model });
      expect(client.openCode.sync).not.toHaveBeenCalled();
    }
    expect(output.stderr).not.toHaveBeenCalled();
    expect(output.stdout).toHaveBeenCalledExactlyOnceWith(
      'Configuration saved. Reopen the tool to use the new settings.\n',
    );
  });
  it.each(['restore', 'remove'])('requires confirmation before %s', async (action) => {
    const { launcher, client, run } = setup();
    expect(await run(['tools', action, 'codex'])).toBe(1);
    expect(launcher.start).not.toHaveBeenCalled();
    expect(client.agentTools.restore).not.toHaveBeenCalled();
    expect(client.agentTools.remove).not.toHaveBeenCalled();
  });
  it('removes only the Manager OpenCode connection after confirmation', async () => {
    const { client, run } = setup();
    expect(
      await run(['tools', 'remove', 'opencode', '--yes', '--base-url', 'http://127.0.0.1:8045/v1']),
    ).toBe(0);
    expect(client.openCode.clear).toHaveBeenCalledExactlyOnceWith({
      baseUrl: 'http://127.0.0.1:8045/v1',
      clearLegacy: false,
    });
  });
  it.each(['not-a-tool', 'codex'])(
    'rejects invalid tool/address before starting (%s)',
    async (tool) => {
      const { launcher, run } = setup();
      expect(
        await run([
          'tools',
          'configure',
          tool,
          '--base-url',
          'https://name:private@example.test',
          '--model',
          'model',
        ]),
      ).toBe(1);
      expect(launcher.start).not.toHaveBeenCalled();
    },
  );
  it('reports owner failure without configuration or credentials', async () => {
    const { client, output, run } = setup();
    vi.mocked(client.agentTools.configure).mockRejectedValue({
      message: 'fixture-private-secret',
      data: { agentToolCode: 'backup-failed' },
    });
    expect(
      await run([
        'tools',
        'configure',
        'codex',
        '--base-url',
        'http://127.0.0.1:8045',
        '--model',
        'model',
      ]),
    ).toBe(1);
    expect(output.stdout).not.toHaveBeenCalled();
    expect(output.stderr).toHaveBeenCalledExactlyOnceWith(
      'Tool settings could not be updated (backup-failed). No credentials were printed.\n',
    );
  });
});
