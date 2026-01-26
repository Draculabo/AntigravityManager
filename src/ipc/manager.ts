import { IPC_CHANNELS } from '@/constants';

// Custom IPC Client that correctly builds method paths
function createIPCClient(port: MessagePort) {
  let requestId = 0;
  const pendingRequests = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();

  port.onmessage = (event) => {
    try {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;

      const id = data.i || data.id;
      const pending = pendingRequests.get(id);
      if (pending) {
        pendingRequests.delete(id);
        if (data.e || data.error) {
          const errorMsg = data.e?.m || data.error?.message || JSON.stringify(data.e || data.error);
          console.error('[IPCClient] Error response:', errorMsg);
          pending.reject(new Error(errorMsg));
        } else {
          // ORPC response format: { i, p: { b: { json: value }, s?: statusCode } }
          // Or error: { i, p: { s: 500, b: { json: { code, message } } } }
          let result;
          const payload = data.p;

          // Check for error status
          if (payload?.s && payload.s >= 400) {
            const errorData = payload.b?.json;
            const errorMsg = errorData?.message || errorData?.code || 'Server error';
            console.error('[IPCClient] Server error:', errorData);
            pending.reject(new Error(errorMsg));
            return;
          }

          // Extract successful result
          if (payload?.b?.json !== undefined) {
            result = payload.b.json;
          } else if (data.r !== undefined) {
            // Fallback to 'r' field if present
            result = data.r?.b?.json ?? data.r;
          } else if ('result' in data) {
            result = data.result;
          }

          pending.resolve(result);
        }
      } else {
        console.warn('[IPCClient] No pending request for id:', id);
      }
    } catch (e) {
      console.error('[IPCClient] Error parsing response:', e, event.data);
    }
  };

  async function callMethod(path: string[], input?: unknown): Promise<any> {
    const id = String(++requestId);
    const methodPath = path.join('/');

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });

      // ORPC MessagePort protocol format
      const payload = {
        i: id,
        p: {
          u: `orpc://localhost/${methodPath}`,
          b: { json: input ?? null },
        },
      };

      port.postMessage(JSON.stringify(payload));

      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`Request /${methodPath} timed out`));
        }
      }, 60000);
    });
  }

  // Create a Proxy that builds the path chain
  function createProxyChain(pathSoFar: string[] = []): any {
    return new Proxy(() => {}, {
      get(_target, prop: string) {
        if (prop === 'then' || prop === 'catch' || prop === 'finally') {
          // Don't intercept promise methods
          return undefined;
        }
        // Build deeper path
        return createProxyChain([...pathSoFar, prop]);
      },
      apply(_target, _thisArg, args) {
        // Called as function - execute RPC
        const input = args[0];
        return callMethod(pathSoFar, input);
      },
    });
  }

  return createProxyChain();
}

class IPCManager {
  private readonly clientPort: MessagePort;
  private readonly serverPort: MessagePort;

  public readonly client: any; // Will be typed via usage

  private initialized: boolean = false;

  constructor() {
    const { port1, port2 } = new MessageChannel();
    this.clientPort = port1;
    this.serverPort = port2;

    this.client = createIPCClient(this.clientPort);
  }

  public initialize() {
    if (this.initialized) {
      return;
    }

    this.clientPort.start();

    window.postMessage(IPC_CHANNELS.START_ORPC_SERVER, '*', [this.serverPort]);
    this.initialized = true;
  }
}

export const ipc = new IPCManager();
ipc.initialize();
