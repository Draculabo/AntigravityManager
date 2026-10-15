import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readClassicTermsAcceptance } from './classic-terms-state.mjs';

test('Classic acceptance requires the selected account and both durable fields', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-classic-terms-'));
  const file = path.join(directory, 'app_storage.json');
  try {
    assert.deepEqual(await readClassicTermsAcceptance(directory, 'b@example.invalid'), {
      state: 'not-recorded',
    });
    for (const [content, expected] of [
      [{ 'jetski.onboarding.lastLoginUsername': 'b@example.invalid' }, { state: 'not-recorded' }],
      [
        {
          'jetski.onboarding.lastLoginUsername': 'a@example.invalid',
          'jetski.onboarding.lastLoginIsGcpTos': 'false',
        },
        { state: 'other-account', tosType: 'standard' },
      ],
      [
        {
          'jetski.onboarding.lastLoginUsername': 'b@example.invalid',
          'jetski.onboarding.lastLoginIsGcpTos': 'false',
          unrelated: 'private-sentinel',
        },
        { state: 'recorded', tosType: 'standard' },
      ],
      [
        {
          'jetski.onboarding.lastLoginUsername': 'b@example.invalid',
          'jetski.onboarding.lastLoginIsGcpTos': 'true',
        },
        { state: 'recorded', tosType: 'gcp' },
      ],
      [
        {
          'jetski.onboarding.lastLoginUsername': 'b@example.invalid',
          'jetski.onboarding.lastLoginIsGcpTos': true,
        },
        { state: 'unreadable' },
      ],
    ]) {
      const original = JSON.stringify(content);
      await fs.writeFile(file, original);
      assert.deepEqual(await readClassicTermsAcceptance(directory, 'b@example.invalid'), expected);
      assert.equal(await fs.readFile(file, 'utf8'), original);
    }
    await fs.writeFile(file, '{');
    assert.deepEqual(await readClassicTermsAcceptance(directory, 'b@example.invalid'), {
      state: 'unreadable',
    });
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
