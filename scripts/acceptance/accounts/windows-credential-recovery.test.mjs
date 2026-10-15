import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { captureWindowsCredential } from './windows-credential-recovery.mjs';

assert.equal(process.platform, 'win32');
assert(process.env.AGM_ACCEPTANCE_NATIVE_ROOT);
assert(process.env.AGM_ACCEPTANCE_HELPERS);
const loadNative = createRequire(path.join(process.env.AGM_ACCEPTANCE_NATIVE_ROOT, 'package.json'));
const library = createRequire(import.meta.url)(
  path.resolve(process.env.AGM_ACCEPTANCE_HELPERS, 'runtime.cjs'),
);

test('native recovery preserves original content and metadata, and is idempotent', async () => {
  const target = `AntigravityManager-Recovery-${randomUUID()}`;
  const absent = captureWindowsCredential(loadNative, target);
  try {
    await library.writeWindowsCredential(target, 'synthetic-original-user', 'synthetic-original');
    const recovery = captureWindowsCredential(loadNative, target);
    // Reproduces value-only cleanup: the payload matches but the original username was lost.
    await library.writeWindowsCredential(target, 'antigravity', 'synthetic-original');
    assert.equal(recovery.restore(), true);
    assert.equal(await library.readWindowsCredential(target), 'synthetic-original');
    assert.equal(recovery.restore(), true);
    assert.equal(await library.readWindowsCredential(target), 'synthetic-original');
  } finally {
    assert.equal(absent.restore(), true);
    assert.equal(await library.readWindowsCredential(target), null);
  }
});

test('native recovery leaves unchanged credentials untouched', async () => {
  const target = `AntigravityManager-Recovery-${randomUUID()}`;
  const absent = captureWindowsCredential(loadNative, target);
  try {
    await library.writeWindowsCredential(target, 'synthetic-user', 'synthetic-value');
    const recovery = captureWindowsCredential(loadNative, target);
    assert.equal(recovery.restore(), true);
    assert.equal(await library.readWindowsCredential(target), 'synthetic-value');
  } finally {
    assert.equal(absent.restore(), true);
    assert.equal(await library.readWindowsCredential(target), null);
  }
});
