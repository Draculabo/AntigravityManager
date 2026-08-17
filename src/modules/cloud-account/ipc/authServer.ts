import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { logger } from '@/shared/logging/logger';
import { ipcContext } from '@/ipc/context';
import { escapeHtml } from '@/shared/utils/url';

export class AuthServer {
  private static server: http.Server | null = null;
  private static PORT = 8888;

  private static handleRequest(req: IncomingMessage, res: ServerResponse, port: number): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      res.end('Method Not Allowed');
      return;
    }

    const url = new URL(req.url || '', `http://localhost:${port}`);

    if (url.pathname === '/oauth-callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (code) {
        const escapedCode = escapeHtml(code);
        logger.info(`AuthServer: Received authorization code: ${escapedCode.substring(0, 10)}...`);

        if (ipcContext.mainWindow) {
          logger.info('AuthServer: Sending code to renderer via IPC');
          ipcContext.mainWindow.webContents.send('GOOGLE_AUTH_CODE', code);
          logger.info('AuthServer: Code sent successfully');
        } else {
          logger.error('AuthServer: Main window not found, cannot send code');
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
            <html>
              <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
                <h1>Login Successful</h1>
                <p>You can close this window and return to Antigravity Manager.</p>
                <script>
                  setTimeout(() => window.close(), 3000);
                </script>
              </body>
            </html>
          `);
      } else if (error) {
        const escapedError = escapeHtml(error);
        logger.error(`AuthServer: OAuth error: ${escapedError}`);
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
            <html>
              <body>
                <h1>Login Failed</h1>
                <p>Error: ${escapedError}</p>
              </body>
            </html>
          `);
      } else {
        res.writeHead(400);
        res.end('Missing code parameter');
      }
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  private static async bind(port: number): Promise<http.Server> {
    const server = http.createServer((req, res) => this.handleRequest(req, res, port));

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('error', onError);
        reject(error);
      };

      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });

    return server;
  }

  static async start() {
    if (this.server) {
      logger.warn('AuthServer: Server already running');
      return;
    }

    const tryPorts = [8888, 8889, 8890, 8891, 8892];

    for (const port of tryPorts) {
      try {
        const server = await this.bind(port);
        this.server = server;
        this.PORT = port;

        server.on('error', (err) => {
          logger.error('AuthServer: Server error', err);
        });

        if (port !== 8888) {
          logger.warn(`AuthServer: Using fallback port ${port} (default 8888 is in use)`);
        }
        logger.info(`AuthServer: Listening on http://localhost:${port}`);
        return;
      } catch {
        logger.debug(`AuthServer: Port ${port} is in use, trying next...`);
      }
    }

    logger.error('AuthServer: No available ports found for OAuth callback server');
  }

  static getRedirectUri(): string {
    return `http://localhost:${this.PORT}/oauth-callback`;
  }

  static async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }

    await new Promise<void>((resolve) => {
      server.close((error) => {
        if (error) {
          logger.warn('AuthServer: Failed to close cleanly', error);
        }
        resolve();
      });
      server.closeAllConnections();
    });
    logger.info('AuthServer: Stopped');
  }
}
