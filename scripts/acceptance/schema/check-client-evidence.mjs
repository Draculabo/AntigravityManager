import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assertConfiguredMcpEvidence } from './live-coding-client.mjs';

// Replay anonymous evidence and prove that missing MCP declarations fail acceptance.
const record = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assertConfiguredMcpEvidence(record.codingClient.gatewayObservations);
let missingServerRejected = false;
try {
  assertConfiguredMcpEvidence([
    {
      status: 200,
      schemas: {
        degraded: false,
        mcpServerSchemas: { codegraph: 1, memory: 0, sequentialThinking: 1 },
      },
    },
  ]);
} catch {
  missingServerRejected = true;
}
const control = createRequire(import.meta.url)(path.resolve(process.argv[3]));
let invalidSchemaRejected = false;
try {
  control.measureClientSchemas([
    { name: 'controlled_probe', input_schema: { $ref: '#/$defs/missing' } },
  ]);
} catch (error) {
  invalidSchemaRejected = error.name === 'SchemaInputError';
}
const result = { liveEvidenceAccepted: true, missingServerRejected, invalidSchemaRejected };
fs.writeFileSync(
  'artifacts/schema-work-package/client-evidence-sensitivity.json',
  `${JSON.stringify(result, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!missingServerRejected || !invalidSchemaRejected) {
  process.exitCode = 1;
}
