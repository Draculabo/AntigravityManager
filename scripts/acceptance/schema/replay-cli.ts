import { replayAuditSchemas } from './replay';
import { z } from 'zod';

try {
  const databasePath = process.argv[2];
  if (!databasePath) {
    throw new Error('Audit database path is required');
  }
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .parse(process.argv[3] ?? 1000);
  const cohort = z.enum(['all', 'unmarked']).parse(process.argv[4] ?? 'all');
  const result = replayAuditSchemas(databasePath, limit, cohort);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  // Missing evidence is distinct from a passing replay and a failed converter.
  process.exitCode = result.available ? 0 : 2;
} catch {
  process.stderr.write('Schema replay could not complete. No request data was exported.\n');
  process.exitCode = 1;
}
