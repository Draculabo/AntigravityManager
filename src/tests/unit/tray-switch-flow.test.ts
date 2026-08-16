import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('tray account switching', () => {
  it('uses the full cloud account switch flow instead of only changing active metadata', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/modules/app-shell/ipc/tray/handler.ts'),
      'utf-8',
    );

    const switchMenuStart = source.indexOf('label: texts.switch_next');
    const refreshMenuStart = source.indexOf('label: texts.refresh_current');
    const switchMenuSource = source.slice(switchMenuStart, refreshMenuStart);

    expect(switchMenuStart).toBeGreaterThanOrEqual(0);
    expect(refreshMenuStart).toBeGreaterThan(switchMenuStart);
    expect(switchMenuSource).toContain("await import('@/modules/cloud-account/ipc/handler')");
    expect(switchMenuSource).toContain('await switchCloudAccount(next.id)');
    expect(switchMenuSource).not.toContain('CloudAccountRepo.setActive(next.id)');
    expect(switchMenuSource.indexOf('await switchCloudAccount(next.id)')).toBeLessThan(
      switchMenuSource.indexOf("webContents.send('tray://account-switched', next.id)"),
    );
  });
});
