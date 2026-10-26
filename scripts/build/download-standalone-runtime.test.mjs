import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { downloadStandaloneAsset, fetchStandaloneText } from './download-standalone-runtime.mjs';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await fs.mkdir('out', { recursive: true });
  const out = await fs.realpath('out');
  const directory = await fs.mkdtemp(path.join(out, 'runtime-download-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(directory)), out);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/win-arm64/node.exe`,
    file: path.join(directory, 'node.exe'),
  };
}

const payload = Buffer.from('verified standalone executable');
const checksum = createHash('sha256').update(payload).digest('hex');

test('checksum and license text recover from a request timeout', async (t) => {
  let requests = 0;
  const { url } = await fixture(t, (_request, response) => {
    requests += 1;
    if (requests > 1) {
      response.end('official metadata');
    }
  });
  assert.equal(
    await fetchStandaloneText(url, { maxBytes: 1000, timeoutMs: 100 }),
    'official metadata',
  );
  assert.equal(requests, 2);
});

test('an asset body timeout restarts the file before checksum verification', async (t) => {
  let requests = 0;
  const { url, file } = await fixture(t, (_request, response) => {
    requests += 1;
    if (requests === 1) {
      response.write('unfinished first download');
    } else {
      response.end(payload);
    }
  });
  await downloadStandaloneAsset(url, file, checksum, 100);
  assert.deepEqual(await fs.readFile(file), payload);
  assert.equal(requests, 2);
});

test('persistent timeouts stop after three attempts and identify the failing asset', async (t) => {
  let requests = 0;
  const { url, file } = await fixture(t, () => {
    requests += 1;
  });
  await assert.rejects(downloadStandaloneAsset(url, file, checksum, 100), (error) => {
    assert.match(error.message, /win-arm64\/node\.exe/);
    assert.match(error.message, /3 attempts/);
    assert.equal(error.cause.name, 'TimeoutError');
    return true;
  });
  assert.equal(requests, 3);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('text body timeouts discard partial metadata before retrying', async (t) => {
  let requests = 0;
  const { url } = await fixture(t, (_request, response) => {
    requests += 1;
    if (requests === 1) {
      response.write('partial metadata');
    } else {
      response.end('complete metadata');
    }
  });
  assert.equal(
    await fetchStandaloneText(url, { maxBytes: 1000, timeoutMs: 100 }),
    'complete metadata',
  );
  assert.equal(requests, 2);
});

test('a transient HTTP response retries the same asset', async (t) => {
  let requests = 0;
  const { url, file } = await fixture(t, (_request, response) => {
    requests += 1;
    if (requests === 1) {
      response.writeHead(503);
      response.end('temporarily unavailable');
    } else {
      response.end(payload);
    }
  });
  await downloadStandaloneAsset(url, file, checksum);
  assert.deepEqual(await fs.readFile(file), payload);
  assert.equal(requests, 2);
});

test('an interrupted socket restarts a partial asset', async (t) => {
  let requests = 0;
  const { url, file } = await fixture(t, (_request, response) => {
    requests += 1;
    if (requests === 1) {
      response.write('interrupted asset');
      setTimeout(() => response.destroy(), 10);
    } else {
      response.end(payload);
    }
  });
  await downloadStandaloneAsset(url, file, checksum);
  assert.deepEqual(await fs.readFile(file), payload);
  assert.equal(requests, 2);
});

test('missing assets fail immediately with HTTP status and URL', async (t) => {
  let requests = 0;
  const { url, file } = await fixture(t, (_request, response) => {
    requests += 1;
    response.writeHead(404);
    response.end('missing asset');
  });
  await assert.rejects(downloadStandaloneAsset(url, file, checksum), (error) => {
    assert(error.message.includes(url));
    assert.match(error.message, /HTTP 404/);
    return true;
  });
  assert.equal(requests, 1);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('checksum mismatches never retry and remove the unverified executable', async (t) => {
  let requests = 0;
  const { url, file } = await fixture(t, (_request, response) => {
    requests += 1;
    response.end('unverified executable');
  });
  await assert.rejects(
    downloadStandaloneAsset(url, file, checksum),
    /Official Node checksum mismatch/,
  );
  assert.equal(requests, 1);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('oversized metadata fails without retrying or retaining its body', async (t) => {
  let requests = 0;
  const { url } = await fixture(t, (_request, response) => {
    requests += 1;
    response.end('oversized metadata');
  });
  await assert.rejects(fetchStandaloneText(url, { maxBytes: 10 }), /exceeds capacity/);
  assert.equal(requests, 1);
});
