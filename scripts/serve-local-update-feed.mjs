import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const project = await realpath(process.cwd());
const outputRoot = await realpath(path.join(project, 'out'));
const feed = await realpath(
  path.resolve(readArg('--dir', path.join(outputRoot, 'make', 'squirrel.windows', 'x64'))),
);
assert(feed.startsWith(`${outputRoot}${path.sep}`), 'Serve only generated output');
assert((await stat(path.join(feed, 'RELEASES'))).isFile(), 'Missing Squirrel RELEASES index');
const port = Number(readArg('--port', '18080'));
assert(Number.isSafeInteger(port) && port > 0 && port <= 65535);

const server = createServer(async (request, response) => {
  let name;
  try {
    name = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1));
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (name !== 'RELEASES' && !/^[A-Za-z0-9_.-]+\.nupkg$/.test(name)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const file = path.join(feed, name);
    const info = await stat(file);
    if (!info.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type':
        name === 'RELEASES' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Squirrel feed ready at http://127.0.0.1:${port}/`);
  console.log(`Serving ${feed}`);
});
