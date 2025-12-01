import { RPCHandler } from "@orpc/server/message-port";
import { router } from "./router";

export const rpcHandler: RPCHandler<Record<never, never>> = new RPCHandler(
  router,
);
