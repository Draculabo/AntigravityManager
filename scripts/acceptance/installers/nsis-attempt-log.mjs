import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const installerLogName = /^installer-.+\.log$/i;
const timeFormat = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const detailStages = new Set(['registration', 'start-menu-shortcut', 'desktop-shortcut']);

export async function listNsisAttemptLogs(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && installerLogName.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function parseFields(line) {
  assert.equal(typeof line, 'string', 'Missing installer diagnostic record');
  const fields = new Map();
  for (const field of line.split('\t')) {
    const delimiter = field.indexOf('=');
    assert(delimiter > 0, 'Invalid installer diagnostic field');
    const key = field.slice(0, delimiter);
    assert(!fields.has(key), 'Duplicate installer diagnostic field');
    fields.set(key, field.slice(delimiter + 1));
  }
  const time = fields.get('time');
  assert(timeFormat.test(time), 'Invalid installer diagnostic time');
  const timestamp = Date.parse(time);
  assert(Number.isFinite(timestamp), 'Invalid installer diagnostic time');
  return { fields, timestamp };
}

export async function readNsisAttempt(
  directory,
  before,
  { version, mode, outcome, stages, error },
) {
  const files = (await listNsisAttemptLogs(directory)).filter((name) => !before.includes(name));
  assert.equal(files.length, 1, 'Expected one new installer diagnostic file');
  const file = path.join(directory, files[0]);
  const info = await lstat(file);
  assert(info.isFile() && info.size <= 64 * 1024, 'Installer diagnostic file exceeds its bounds');
  const bytes = await readFile(file);
  assert(
    bytes[0] === 0xff && bytes[1] === 0xfe && bytes.length % 2 === 0,
    'Invalid installer diagnostic encoding',
  );
  const lines = bytes.subarray(2).toString('utf16le').trimEnd().split('\r\n');
  const header = parseFields(lines.shift()).fields;
  assert.equal(header.get('version'), version, 'Installer logged the wrong version');
  assert.equal(header.get('arch'), 'x64', 'Installer logged the wrong architecture');
  assert.equal(header.get('mode'), mode, 'Installer logged the wrong execution mode');
  const starts = [];
  const durations = [];
  let active;
  const terminal = parseFields(lines.at(-1));
  assert.equal(terminal.fields.get('stage'), 'install', 'Missing terminal installer result');
  for (const [index, line] of lines.entries()) {
    const { fields, timestamp } = parseFields(line);
    const stage = fields.get('stage');
    const result = fields.get('result');
    if (stage === 'install') {
      assert.equal(index, lines.length - 1, 'Installer reported multiple terminal results');
      assert(!active, 'Installer ended with an unfinished stage');
      continue;
    }
    if (detailStages.has(stage)) {
      assert.equal(active?.stage, 'register-installation', 'Unexpected installer setup detail');
      assert(['ok', 'warning', 'skipped'].includes(result), 'Unexpected installer setup result');
      continue;
    }
    if (result === 'started') {
      assert(!active, 'Installer started a stage before finishing its previous stage');
      starts.push(stage);
      active = { stage, timestamp };
    } else {
      assert.equal(active?.stage, stage, 'Installer reported a result for the wrong stage');
      assert(
        ['ok', 'warning', 'failed', 'cancelled', 'skipped'].includes(result),
        'Unexpected installer stage result',
      );
      durations.push({
        stage,
        result,
        elapsedMs: timestamp >= active.timestamp ? timestamp - active.timestamp : null,
      });
      active = undefined;
    }
  }
  assert.deepEqual(starts, stages, 'Unexpected installer diagnostic stages');
  assert.equal(terminal.fields.get('result'), outcome, 'Installer logged the wrong result');
  assert.equal(terminal.fields.get('error'), error, 'Installer logged the wrong error');
  return durations;
}
