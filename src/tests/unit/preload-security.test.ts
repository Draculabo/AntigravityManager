import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('preload security boundaries', () => {
  it('only forwards the ORPC MessagePort from the main window with one transferred port', () => {
    const preloadSource = readFileSync(path.join(process.cwd(), 'src/preload.ts'), 'utf-8');

    expect(preloadSource).toContain('event.source !== window');
    expect(preloadSource).toContain('event.data !== IPC_CHANNELS.START_ORPC_SERVER');
    expect(preloadSource).toContain('event.ports.length !== 1');
    expect(preloadSource).toContain(
      'ipcRenderer.postMessage(IPC_CHANNELS.START_ORPC_SERVER, null, [serverPort])',
    );
  });
});
