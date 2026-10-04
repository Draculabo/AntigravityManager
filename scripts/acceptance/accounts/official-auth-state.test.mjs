import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readOfficialSignedIn } from './official-auth-state.mjs';

test('requires a fresh final signed-in transition from the latest official session', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-official-auth-'));
  const root = path.join(home, 'client-ide/logs');
  const since = new Date('2026-10-03T10:00:00.000').getTime();
  const older = path.join(root, '20261003T095900');
  const latest = path.join(root, '20261003T100000');
  try {
    assert.equal(await readOfficialSignedIn(home, 'ide', since), false);
    await fs.mkdir(older, { recursive: true });
    await fs.writeFile(
      path.join(older, 'auth.log'),
      '2026-10-03 09:59:01.000 [info] [Auth] Auth state changed to: signedIn\n',
    );
    assert.equal(await readOfficialSignedIn(home, 'ide', since), false);
    await fs.mkdir(latest);
    await fs.writeFile(
      path.join(latest, 'auth.log'),
      '2026-10-03 10:00:01.000 [info] [Auth] Auth state changed to: signedIn\n2026-10-03 10:00:02.000 [info] [Auth] Auth state changed to: validatingLogin\n',
    );
    assert.equal(await readOfficialSignedIn(home, 'ide', since), false);
    await fs.appendFile(
      path.join(latest, 'auth.log'),
      '2026-10-03 10:00:03.000 [info] [Auth] Auth state changed to: signedIn\n',
    );
    assert.equal(await readOfficialSignedIn(home, 'ide', since), true);
    assert.equal(await readOfficialSignedIn(home, 'classic', since), false);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
