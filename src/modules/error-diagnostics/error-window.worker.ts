import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { ErrorWindowRepository } from './error-window.repository';
import { ErrorWindowCommandSchema } from './error-window.schema';

const data = z
  .object({ databasePath: z.string().min(1), role: z.enum(['app', 'core']) })
  .parse(workerData);
const port = parentPort;
if (!port) {
  throw new Error('Local error diagnostic worker requires a parent port');
}
const repository = new ErrorWindowRepository(data.databasePath, data.role);
const EnvelopeSchema = z.object({
  id: z.number().int().safe().positive(),
  operation: z.string(),
  payload: z.unknown(),
});
port.on('message', (value: unknown) => {
  const envelope = EnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    return;
  }
  try {
    const command = ErrorWindowCommandSchema.parse(envelope.data);
    port.postMessage({ id: envelope.data.id, result: repository.execute(command) });
  } catch (error) {
    port.postMessage({
      id: envelope.data.id,
      error: error instanceof Error ? error.message : 'Local error diagnostic operation failed',
    });
  }
});
