import { parentPort, workerData } from 'node:worker_threads';

import { z } from 'zod';

import { TrafficAuditRepository } from './traffic-audit.repository';
import {
  TrafficAuditWorkerCommandSchema,
  TrafficAuditWorkerMessageSchema,
} from './traffic-audit.worker-protocol';

const WorkerDataSchema = z.object({ databasePath: z.string().min(1) });
const port = parentPort;
if (!port) {
  throw new Error('Traffic audit worker requires a parent port');
}

const repository = new TrafficAuditRepository(WorkerDataSchema.parse(workerData).databasePath);

port.on('message', (value: unknown) => {
  const envelope = TrafficAuditWorkerMessageSchema.safeParse(value);
  if (!envelope.success) {
    return;
  }
  try {
    const command = TrafficAuditWorkerCommandSchema.parse({
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
