import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ORPC preload bridge security', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/preload.ts'), 'utf-8');

  it('only installs the bridge in the main frame', () => {
    expect(source).toContain('if (process.isMainFrame)');
  });

  it('only forwards self-originated messages with exactly one transferred port', () => {
    expect(source).toContain('event.source !== window');
    expect(source).toContain('event.data !== IPC_CHANNELS.START_ORPC_SERVER');
    expect(source).toContain('event.ports.length !== 1');
  });
});
