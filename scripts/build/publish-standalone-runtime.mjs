import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export class RuntimeRecoveryError extends AggregateError {
  constructor(error, rollbackError, backup) {
    super([error, rollbackError], `Runtime rollback requires recovery from ${backup}`);
  }
}

/** Publish only a verified, generated runtime; preserve its backup if recovery fails. */
export async function publishStandaloneRuntime(root, destination, { platform, arch }) {
  const stage = path.dirname(root);
  const parent = await fs.realpath(path.dirname(destination));
  assert.equal(await fs.realpath(root), root);
  assert.equal(path.dirname(await fs.realpath(stage)), parent);
  assert(path.basename(stage).startsWith('stage-'));
  assert.equal(destination, path.join(parent, 'standalone'));
  const backup = path.join(stage, 'previous');
  let previous = false;
  try {
    await fs.stat(destination);
    previous = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  if (previous) {
    assert.equal(await fs.realpath(destination), destination);
    const old = JSON.parse(
      await fs.readFile(path.join(destination, 'runtime-manifest.json'), 'utf8'),
    );
    assert.equal(old.version, 1);
    assert.equal(old.platform, platform);
    assert.equal(old.arch, arch);
  }

  const copy = { recursive: true, force: false, errorOnExist: true };
  const remove = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
  // Windows can deny renaming a populated directory even after all build children exit.
  // Forge awaits this entire operation before consuming the destination.
  if (platform === 'win32') {
    if (previous) {
      await fs.cp(destination, backup, copy);
    }
    try {
      if (previous) {
        await fs.rm(destination, remove);
      }
      await fs.cp(root, destination, copy);
    } catch (error) {
      try {
        await fs.rm(destination, remove);
        if (previous) {
          await fs.cp(backup, destination, copy);
        }
      } catch (rollbackError) {
        throw new RuntimeRecoveryError(error, rollbackError, previous ? backup : root);
      }
      throw error;
    }
    return;
  }

  if (previous) {
    await fs.rename(destination, backup);
  }
  try {
    await fs.rename(root, destination);
  } catch (error) {
    if (previous) {
      try {
        await fs.rename(backup, destination);
      } catch (rollbackError) {
        throw new RuntimeRecoveryError(error, rollbackError, backup);
      }
    }
    throw error;
  }
}
