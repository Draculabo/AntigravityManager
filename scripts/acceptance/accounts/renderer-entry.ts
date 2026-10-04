import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/message-port';
const { port1, port2 } = new MessageChannel();
const client = createORPCClient(new RPCLink({ port: port1 }));
port1.start();
window.postMessage('start-orpc-server', '*', [port2]);
Object.assign(window, { accountAcceptance: client });
