import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyDshProviderPatch,
  DshProfileConflictError,
  planDshProviderPatch,
  removeDshProviderPatch,
  resolveDshProfileLocation,
  writeDshProviderPatch,
} from '@/modules/proxy-gateway/dsh-sync/dsh-profile-config';

const provider = {
  id: 'manager',
  protocol: 'openai-completions' as const,
  baseUrl: 'http://127.0.0.1:8045/v1',
  credentialRef: 'manager-key',
  models: [{ id: 'gemini-3-flash' }],
};

describe('DSH profile provider configuration', () => {
  it('resolves a profile below DSH_HOME without changing the root cordis file', () => {
    expect(resolveDshProfileLocation('C:/dsh', 'web').patchPath).toBe(
      'C:\\dsh\\profiles\\web\\cordis.patch.yml',
    );
  });

  it('merges a Manager provider while retaining other providers and comments', () => {
    const source = [
      '# keep this comment',
      'entries:',
      '  - plugin: llm-pi-ai',
      '    config:',
      '      providers:',
      '        personal:',
      '          protocol: openai-completions',
      '          baseUrl: https://example.test/v1',
      '',
    ].join('\n');
    const plan = planDshProviderPatch(source, 'profile.yml', provider);
    const updated = applyDshProviderPatch(source, provider);
    expect(plan.previousProvider).toBeUndefined();
    expect(updated).toContain('# keep this comment');
    expect(updated).toContain('personal:');
    expect(updated).toContain('manager:');
    expect(updated).toContain('credentialRef: manager-key');
  });

  it('removes only the selected provider', () => {
    const source = [
      'config:',
      '  providers:',
      '    personal:',
      '      protocol: openai-completions',
      '    manager:',
      '      protocol: openai-completions',
      '',
    ].join('\n');
    const updated = removeDshProviderPatch(source, 'manager');
    expect(updated).toContain('personal:');
    expect(updated).not.toContain('manager:');
  });

  it('rejects custom YAML tags instead of executing or preserving configuration code', () => {
    expect(() =>
      applyDshProviderPatch('config: !!js/function "return 1"', provider),
    ).toThrow(/DSH profile YAML is invalid|DSH profile YAML is ambiguous/);
  });

  it('writes through a backup and refuses to overwrite a changed profile', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-profile-'));
    const location = resolveDshProfileLocation(home, 'web');
    await writeFile(
      location.patchPath,
      ['config:', '  providers:', '    personal:', '      protocol: openai-completions', ''].join(
        '\n',
      ),
    ).catch(async (error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        await (await import('node:fs/promises')).mkdir(path.dirname(location.patchPath), {
          recursive: true,
        });
        await writeFile(
          location.patchPath,
          ['config:', '  providers:', '    personal:', '      protocol: openai-completions', ''].join(
            '\n',
          ),
        );
        return;
      }
      throw error;
    });

    const source = await readFile(location.patchPath, 'utf8');
    const planned = planDshProviderPatch(source, location.patchPath, provider);
    const result = await writeDshProviderPatch(location, provider, planned.sourceHash);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBe(`${location.patchPath}.antigravity-manager.bak`);
    expect(await readFile(result.backupPath!, 'utf8')).toBe(source);
    expect(await readFile(location.patchPath, 'utf8')).toContain('manager:');

    await writeFile(location.patchPath, `${await readFile(location.patchPath, 'utf8')}# changed\n`);
    await expect(writeDshProviderPatch(location, provider, result.sourceHash)).rejects.toBeInstanceOf(
      DshProfileConflictError,
    );
  });
});
