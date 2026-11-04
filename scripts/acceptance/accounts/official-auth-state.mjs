import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

/** Use the runtime's identity gate for every main process inspected by the acceptance runner. */
export async function confirmOfficialIdeAgent(library, email) {
  const context = await library.prepareLaunchContext('ide');
  assert(context.processes.length > 0, 'No launched IDE main process to confirm');
  for (const main of context.processes) {
    await library.confirmIdeAccountIdentity(context, main.pid, email);
  }
  return true;
}

/** Require a fresh signed-in transition from the selected official client's private log. */
export async function readOfficialSignedIn(home, target, since) {
  const root = path.join(home, `client-${target}`, 'logs');
  try {
    const directories = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const latest = directories.at(-1);
    if (!latest) {
      return false;
    }
    const file = path.join(root, latest, 'auth.log');
    if ((await fs.stat(file)).size > 1000000) {
      return false;
    }
    const content = await fs.readFile(file, 'utf8');
    const states = [
      ...content.matchAll(
        /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}).*Auth state changed to: (\w+)/gm,
      ),
    ];
    const last = states.at(-1);
    return Boolean(
      last && last[2] === 'signedIn' && new Date(last[1].replace(' ', 'T')).getTime() >= since,
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
