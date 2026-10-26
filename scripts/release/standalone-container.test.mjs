import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const dockerfile = await readFile(new URL('../../docker/standalone-core/Dockerfile', import.meta.url), 'utf8');
const entrypoint = await readFile(
  new URL('../../docker/standalone-core/entrypoint.sh', import.meta.url),
  'utf8',
);

test('standalone container is pinned to the prepared runtime and drains on SIGTERM', () => {
  assert.match(dockerfile, /dist\/\.runtime\/linux-\$\{RUNTIME_ARCH\}\/standalone/u);
  assert.match(dockerfile, /STOPSIGNAL SIGTERM/u);
  assert.match(dockerfile, /VOLUME \["\/var\/lib\/antigravity-manager"\]/u);
  assert.match(entrypoint, /service stop/u);
  assert.match(entrypoint, /trap finish INT TERM/u);
  assert.match(entrypoint, /service status/u);
});
