import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';

const databasePath =
  process.argv[2] ??
  path.join(process.env.USERPROFILE, '.antigravity-agent', 'proxy-state', 'request-audit.db');
let phase = 'open';
try {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  phase = 'query';
  console.log(
    JSON.stringify({
      version: database.prepare('PRAGMA user_version').get(),
      tables: database.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 20").all(),
    }),
  );
  console.log(
    JSON.stringify({
      protocols: database
        .prepare('SELECT protocol,COUNT(*) AS count FROM request_logs GROUP BY protocol LIMIT 20')
        .all(),
    }),
  );
  const groups = database
    .prepare(
      'SELECT p.kind,p.representation,p.state,p.partial,p.oversized,COUNT(*) AS count FROM request_body_refs r JOIN audit_payloads p ON p.id=r.payload_id GROUP BY p.kind,p.representation,p.state,p.partial,p.oversized LIMIT 20',
    )
    .all();
  console.log(JSON.stringify({ groups }));
  const classes = database
    .prepare(
      "SELECT l.protocol,l.traffic_class,p.state,COUNT(*) AS count,MAX(p.logical_bytes) AS maxBytes FROM request_body_refs r JOIN audit_payloads p ON p.id=r.payload_id JOIN request_logs l ON l.id=r.request_id WHERE r.direction='request' AND p.kind='json' GROUP BY l.protocol,l.traffic_class,p.state LIMIT 30",
    )
    .all();
  console.log(JSON.stringify({ classes }));
  const roots = {
    selected: 0,
    object: 0,
    string: 0,
    array: 0,
    invalid: 0,
    doubleEncodedObject: 0,
    requestShape: 0,
    doubleEncodedRequestShape: 0,
  };
  const candidates = database
    .prepare(
      "SELECT p.id FROM request_body_refs r JOIN audit_payloads p ON p.id=r.payload_id WHERE r.direction='request' AND p.kind='json' AND p.state='complete' AND p.partial=0 AND p.oversized=0 AND p.logical_bytes<=4194304 ORDER BY p.created_at DESC LIMIT 1000",
    )
    .all();
  const isRequest = (value) =>
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ['tools', 'messages', 'input', 'contents'].some((key) => Object.hasOwn(value, key));
  for (const row of candidates) {
    const chunks = database
      .prepare('SELECT payload,encoding FROM audit_payload_chunks WHERE payload_id=? ORDER BY seq')
      .all(row.id);
    if (chunks.reduce((sum, chunk) => sum + chunk.payload.length, 0) > 4194304) {
      continue;
    }
    roots.selected++;
    try {
      const text = Buffer.concat(
        chunks.map((chunk) =>
          chunk.encoding === 'gzip'
            ? gunzipSync(chunk.payload, { maxOutputLength: 4194304 })
            : Buffer.from(chunk.payload),
        ),
      ).toString('utf8');
      const value = JSON.parse(text);
      if (isRequest(value)) {
        roots.requestShape++;
      }
      if (typeof value === 'string') {
        roots.string++;
        try {
          const nested = JSON.parse(value);
          if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            roots.doubleEncodedObject++;
          }
          if (isRequest(nested)) {
            roots.doubleEncodedRequestShape++;
          }
        } catch {
          /* Ordinary stored strings are not request objects. */
        }
      } else if (Array.isArray(value)) {
        roots.array++;
      } else if (value && typeof value === 'object') {
        roots.object++;
      } else {
        roots.invalid++;
      }
    } catch {
      roots.invalid++;
    }
  }
  console.log(JSON.stringify({ roots }));
  database.close();
} catch (error) {
  console.log(JSON.stringify({ available: false, phase, code: error.code }));
}
