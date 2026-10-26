import { parentPort, workerData } from 'node:worker_threads';

import { z } from 'zod';

import { TrafficAuditRepository } from './traffic-audit.repository';
import { createTrafficAuditWorkerDispatcher } from './traffic-audit-worker-dispatcher';
import {
  TrafficAuditWorkerCommandSchema,
  TrafficAuditWorkerMessageSchema,
} from './traffic-audit.worker-protocol';

const WorkerDataSchema = z.object({
  databasePath: z.string().min(1),
  ownerStartedAt: z.number().int().nonnegative().optional(),
});
const port = parentPort;
if (!port) {
  throw new Error('Traffic audit worker requires a parent port');
}

const initialization = WorkerDataSchema.parse(workerData);
const repository = new TrafficAuditRepository(
  initialization.databasePath,
  initialization.ownerStartedAt,
);
const dispatch = createTrafficAuditWorkerDispatcher(repository, (reply) => port.postMessage(reply));

port.on('message', (value: unknown) => {
  const envelope = TrafficAuditWorkerMessageSchema.safeParse(value);
  if (!envelope.success) {
    const identity = z.object({ id: z.number().int().positive() }).safeParse(value);
    if (identity.success) {
      port.postMessage({ id: identity.data.id, error: 'Invalid traffic audit worker message' });
    }
    return;
  }
  try {
    const command = TrafficAuditWorkerCommandSchema.parse({
      operation: envelope.data.operation,
      payload: envelope.data.payload,
    });
    dispatch(envelope.data.id, command, envelope.data.maxDiskBytes, envelope.data.capture);
  } catch (error) {
    port.postMessage({
      error: error instanceof Error ? error.message : String(error),
      id: envelope.data.id,
    });
  }
});
