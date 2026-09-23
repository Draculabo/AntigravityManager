import { parentPort, workerData } from 'node:worker_threads';

import { z } from 'zod';

import { ThoughtStoreRepository } from './thought-store.repository';
import {
  ThoughtStoreWorkerCommandSchema,
  ThoughtStoreWorkerMessageSchema,
} from './thought-store.worker-protocol';

const WorkerDataSchema = z.object({ databasePath: z.string().min(1) });
const port = parentPort;
if (!port) {
  throw new Error('Thought Store worker requires a parent port');
}

const repository = new ThoughtStoreRepository(WorkerDataSchema.parse(workerData).databasePath);

port.on('message', (value: unknown) => {
  const envelope = ThoughtStoreWorkerMessageSchema.safeParse(value);
  if (!envelope.success) {
    return;
  }
  try {
    const command = ThoughtStoreWorkerCommandSchema.parse({
      operation: envelope.data.operation,
      payload: envelope.data.payload,
    });
    port.postMessage({ id: envelope.data.id, result: repository.execute(command) });
  } catch (error) {
    port.postMessage({
      error: error instanceof Error ? error.message : String(error),
      id: envelope.data.id,
    });
  }
});
