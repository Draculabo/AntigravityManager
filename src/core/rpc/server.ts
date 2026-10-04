import { RPCHandler } from '@orpc/server/fastify';
import {
  IPC_CAPTURE_CHUNK_REQUEST_BYTES,
  IPC_CAPTURE_HEADER,
  IpcCaptureCapabilitySchema,
} from '@/modules/proxy-gateway/audit/ipc-capture.schema';
import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import type { CoreStatus } from '@/core/core-service';
import { createCoreRpcRouter, type CoreRpcOperations } from './router';
import { SERVICE_CONFIG_MAX_BYTES } from '@/modules/config/service-config.schema';
import { OPEN_CODE_SYNC_MAX_BYTES } from '@/modules/proxy-gateway/opencode-sync/opencode-owner.schema';

export function registerCoreRpcRoutes(
  server: FastifyInstance,
  getStatus: () => CoreStatus,
  isShuttingDown: () => boolean,
  operations: CoreRpcOperations,
): void {
  const handler = new RPCHandler(createCoreRpcRouter(operations));
  const dispatch: RouteHandlerMethod = async (request, reply) => {
    if (isShuttingDown() || getStatus().state !== 'running') {
      return reply.code(503).send({ error: 'Core application RPC is not ready' });
    }
    const dispatchRpc = () => handler.handle(request, reply, { prefix: '/rpc' });
    const header = request.headers[IPC_CAPTURE_HEADER];
    let matched: boolean;
    if (header !== undefined) {
      if (typeof header !== 'string') {
        return reply.code(400).send({ error: 'Invalid IPC capture' });
      }
      const [epoch, token, extra] = header.split('.');
      const capability = IpcCaptureCapabilitySchema.safeParse({ epoch, token });
      if (
        extra !== undefined ||
        !capability.success ||
        request.url.startsWith('/rpc/ipcCapture/')
      ) {
        return reply.code(400).send({ error: 'Invalid IPC capture' });
      }
      try {
        ({ matched } = await operations.ipcCapture.run(capability.data, dispatchRpc));
      } catch {
        return reply.code(503).send({ error: 'IPC capture is unavailable' });
      }
    } else {
      ({ matched } = await dispatchRpc());
    }
    if (matched) {
      return reply;
    }
    return reply.code(404).send({ error: 'RPC procedure not found' });
  };
  // Configuration/model tables use scoped limits. Other procedures keep the 4 KiB limit.
  server.all('/rpc/serviceConfig/update', { bodyLimit: SERVICE_CONFIG_MAX_BYTES + 4096 }, dispatch);
  server.all('/rpc/openCode/sync', { bodyLimit: OPEN_CODE_SYNC_MAX_BYTES + 4096 }, dispatch);
  server.all('/rpc/ipcCapture/append', { bodyLimit: IPC_CAPTURE_CHUNK_REQUEST_BYTES }, dispatch);
  server.all(
    '/rpc/ipcCapture/appendMetadata',
    { bodyLimit: IPC_CAPTURE_CHUNK_REQUEST_BYTES },
    dispatch,
  );
  server.all('/rpc/*', dispatch);
}
