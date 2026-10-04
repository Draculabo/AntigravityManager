import { ORPCError, os } from '@orpc/server';
import type { IpcCaptureOperations } from './ipc-capture-owner';
import {
  IpcCaptureBeginSchema,
  IpcCaptureBeginResultSchema,
  IpcCapturePayloadSchema,
  IpcCaptureAppendSchema,
  IpcCapturePayloadFinishSchema,
  IpcCaptureFinishSchema,
  IpcCaptureAckSchema,
  IpcCaptureCapabilitySchema,
  IpcCaptureMetadataAppendSchema,
  IpcCapturePreparedSchema,
} from './ipc-capture.schema';

export function createIpcCaptureRouter(owner: IpcCaptureOperations) {
  const procedure = os.use(async ({ next }) => {
    try {
      return await next({});
    } catch {
      throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'IPC capture is unavailable.' });
    }
  });
  return {
    prepare: procedure.output(IpcCaptureCapabilitySchema).handler(() => owner.prepare()),
    appendMetadata: procedure
      .input(IpcCaptureMetadataAppendSchema)
      .output(IpcCaptureAckSchema)
      .handler(({ input }) => owner.appendMetadata(input)),
    beginPrepared: procedure
      .input(IpcCapturePreparedSchema)
      .output(IpcCaptureBeginResultSchema)
      .handler(({ input }) => owner.beginPrepared(input)),
    begin: procedure
      .input(IpcCaptureBeginSchema)
      .output(IpcCaptureBeginResultSchema)
      .handler(({ input }) => owner.begin(input)),
    payload: procedure
      .input(IpcCapturePayloadSchema)
      .output(IpcCaptureAckSchema)
      .handler(({ input }) => owner.payload(input)),
    append: procedure
      .input(IpcCaptureAppendSchema)
      .output(IpcCaptureAckSchema)
      .handler(({ input }) => owner.append(input)),
    finishPayload: procedure
      .input(IpcCapturePayloadFinishSchema)
      .output(IpcCaptureAckSchema)
      .handler(({ input }) => owner.finishPayload(input)),
    finish: procedure
      .input(IpcCaptureFinishSchema)
      .output(IpcCaptureAckSchema)
      .handler(({ input }) => owner.finish(input)),
  };
}
