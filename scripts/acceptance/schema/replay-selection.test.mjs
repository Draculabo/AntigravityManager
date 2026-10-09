import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';

const directories = [];
let bundleDirectory;
before(async () => {
  bundleDirectory = mkdtempSync(path.join(os.tmpdir(), 'agm-schema-audit-test-bundle-'));
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: true,
      target: 'node22',
      outDir: bundleDirectory,
      emptyOutDir: false,
      rollupOptions: {
        input: 'scripts/acceptance/schema/replay-cli.ts',
        output: { format: 'cjs', entryFileNames: 'replay.cjs' },
      },
    },
  });
});
function cleanup(directory) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('agm-schema-audit-test-'));
  rmSync(resolved, { recursive: true, force: true });
}
after(() => {
  if (bundleDirectory) {
    cleanup(bundleDirectory);
  }
});
afterEach(() => {
  for (const directory of directories.splice(0)) {
    cleanup(directory);
  }
});

function replay(file, limit = 1000, cohort = 'all') {
  const run = spawnSync(
    process.execPath,
    [path.join(bundleDirectory, 'replay.cjs'), file, String(limit), cohort],
    {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 16_000,
      windowsHide: true,
      env: { ...process.env, NODE_PATH: path.resolve('node_modules') },
    },
  );
  const summary = z
    .object({
      selected: z.number(),
      replayed: z.number(),
      schemas: z.number(),
      available: z.boolean(),
      degraded: z.number(),
      rejected: z.number(),
      excludedShape: z.number(),
    })
    .parse(JSON.parse(run.stdout));
  assert.equal(run.status, summary.available ? 0 : 2);
  return summary;
}

function fixture(rows) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agm-schema-audit-test-'));
  directories.push(directory);
  const file = path.join(directory, 'audit.db');
  const database = new DatabaseSync(file);
  database.exec(
    'CREATE TABLE request_logs(id TEXT,protocol TEXT,traffic_class TEXT,request_headers TEXT); CREATE TABLE request_body_refs(request_id TEXT,payload_id TEXT,direction TEXT); CREATE TABLE audit_payloads(id TEXT,logical_bytes INTEGER,chunk_count INTEGER,sha256 TEXT,sha256_scope TEXT,kind TEXT,representation TEXT,state TEXT,partial INTEGER,oversized INTEGER,created_at INTEGER); CREATE TABLE audit_payload_chunks(payload_id TEXT,seq INTEGER,encoding TEXT,payload BLOB);',
  );
  rows.forEach((row, index) => {
    const id = String(index);
    const bytes = Buffer.from(JSON.stringify(row.body));
    database
      .prepare('INSERT INTO request_logs VALUES(?,?,?,?)')
      .run(id, row.protocol, row.trafficClass, Object.hasOwn(row, 'headers') ? row.headers : '{}');
    database.prepare('INSERT INTO request_body_refs VALUES(?,?,?)').run(id, id, 'request');
    database
      .prepare('INSERT INTO audit_payloads VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        bytes.length,
        1,
        createHash('sha256').update(bytes).digest('hex'),
        'full',
        'json',
        'sanitized_json',
        row.state ?? 'complete',
        0,
        0,
        index,
      );
    database.prepare('INSERT INTO audit_payload_chunks VALUES(?,?,?,?)').run(id, 0, 'raw', bytes);
  });
  database.close();
  return file;
}

describe('audit Schema replay selects model requests', () => {
  const body = {
    tools: [
      {
        name: 'fixture',
        input_schema: { type: 'object', properties: { value: { type: 'string' } } },
      },
    ],
  };
  it('excludes newer IPC/admin and expired model records before applying the sample limit', () => {
    const result = replay(
      fixture([
        { protocol: 'anthropic', trafficClass: 'model', body },
        { protocol: 'openai', trafficClass: 'model', state: 'expired', body },
        { protocol: 'ipc', trafficClass: 'ipc', body: { ui: true } },
        { protocol: 'admin-http', trafficClass: 'admin', body: { status: true } },
      ]),
      1,
    );
    assert.deepEqual(result, {
      selected: 1,
      replayed: 1,
      schemas: 1,
      available: true,
      degraded: 0,
      rejected: 0,
      excludedShape: 0,
    });
  });
  it('reports unavailable evidence when only complete IPC data remains', () => {
    const result = replay(fixture([{ protocol: 'ipc', trafficClass: 'ipc', body }]));
    assert.deepEqual(result, {
      selected: 0,
      replayed: 0,
      schemas: 0,
      available: false,
      degraded: 0,
      rejected: 0,
      excludedShape: 0,
    });
  });
  it('includes OpenAI Chat and Responses function schemas', () => {
    const result = replay(
      fixture([
        {
          protocol: 'openai',
          trafficClass: 'model',
          body: {
            tools: [
              {
                type: 'function',
                function: { name: 'fixture', parameters: body.tools[0].input_schema },
              },
            ],
          },
        },
      ]),
    );
    assert.deepEqual(result, {
      selected: 1,
      replayed: 1,
      schemas: 1,
      available: true,
      degraded: 0,
      rejected: 0,
      excludedShape: 0,
    });
  });
  it('excludes case-insensitive acceptance headers before limiting the unmarked cohort', () => {
    const marked = {
      tools: [
        {
          name: 'private-probe',
          input_schema: { type: 'object', properties: { value: { $ref: '#/missing' } } },
        },
      ],
    };
    const result = replay(
      fixture([
        { protocol: 'anthropic', trafficClass: 'model', body },
        {
          protocol: 'anthropic',
          trafficClass: 'model',
          body: marked,
          headers: '{"X-Schema-Acceptance":"private-controlled-marker"}',
        },
      ]),
      1,
      'unmarked',
    );
    assert.deepEqual(result, {
      selected: 1,
      replayed: 1,
      schemas: 1,
      available: true,
      degraded: 0,
      rejected: 0,
      excludedShape: 0,
    });
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-probe|private-controlled-marker|request_headers/,
    );
  });
  it('retains no-evidence exit 2 when the only schemas are marked acceptance requests', () => {
    const result = replay(
      fixture([
        {
          protocol: 'anthropic',
          trafficClass: 'model',
          body,
          headers: '{"x-schema-acceptance":"controlled"}',
        },
      ]),
      1000,
      'unmarked',
    );
    assert.deepEqual(result, {
      selected: 0,
      replayed: 0,
      schemas: 0,
      available: false,
      degraded: 0,
      rejected: 0,
      excludedShape: 0,
    });
  });
  it('excludes unknown header provenance without treating header values as marker keys', () => {
    const rows = [null, 'not-json', 'null', '[]', '{"user-agent":"x-schema-acceptance"}'].map(
      (headers) => ({
        protocol: 'anthropic',
        trafficClass: 'model',
        body,
        headers,
      }),
    );
    const file = fixture(rows);
    assert.equal(replay(file).selected, 5);
    assert.deepEqual(replay(file, 1000, 'unmarked'), {
      selected: 1,
      replayed: 1,
      schemas: 1,
      available: true,
      degraded: 0,
      rejected: 0,
      excludedShape: 0,
    });
  });
});
