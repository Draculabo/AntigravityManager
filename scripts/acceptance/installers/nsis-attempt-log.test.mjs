import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listNsisAttemptLogs, readNsisAttempt } from './nsis-attempt-log.mjs';

test('checks installer results and derives stage durations outside the installer', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agm-nsis-log-test-'));
  try {
    await writeFile(path.join(directory, 'app-2026-11-15.log'), 'Application log');
    const before = await listNsisAttemptLogs(directory);
    const file = path.join(directory, 'installer-2026-11-15-000000-12345.log');
    const lines = [
      'time=2026-11-15T00:00:00Z\tversion=0.31.0\tarch=x64\tmode=update',
      'time=2026-11-15T00:00:01Z\tstage=prepare-files\tresult=started',
      'time=2026-11-15T00:00:03Z\tstage=prepare-files\tresult=ok',
      'time=2026-11-15T00:00:03Z\tstage=extract-files\tresult=started',
      'time=2026-11-15T00:00:07Z\tstage=extract-files\tresult=ok',
      'time=2026-11-15T00:00:07Z\tstage=install\tresult=ok',
    ];
    const write = () => writeFile(file, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf16le');
    const expected = {
      version: '0.31.0',
      mode: 'update',
      outcome: 'ok',
      stages: ['prepare-files', 'extract-files'],
    };
    await write();
    assert.deepEqual(await readNsisAttempt(directory, before, expected), [
      { stage: 'prepare-files', result: 'ok', elapsedMs: 2000 },
      { stage: 'extract-files', result: 'ok', elapsedMs: 4000 },
    ]);
    lines.pop();
    await write();
    await assert.rejects(readNsisAttempt(directory, before, expected), /Missing terminal/);
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
});
