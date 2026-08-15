import http from 'http';
import { logger } from '@/shared/logging/logger';
import { ipcContext } from '@/ipc/context';
import { escapeHtml } from '@/shared/utils/url';

export class AuthServer {
  private static server: http.Server | null = null;
  private static PORT = 8888;

  private static handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      res.end('Method Not Allowed');
      return;
    }

    const url = new URL(req.url || '', `http://localhost:${this.PORT}`);

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
        return;
      }

      if (error) {
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
        return;
      }

      res.writeHead(400);
      res.end('Missing code parameter');
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  private static async bind(port: number): Promise<http.Server> {
    const server = http.createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        server.off('listening', handleListening);
        reject(error);
      };
      const handleListening = () => {
        server.off('error', handleError);
        resolve();
      };

      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(port, '127.0.0.1');
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
        this.PORT = port;
        this.server = server;

        if (port !== 8888) {
          logger.warn(`AuthServer: Using fallback port ${port} (default 8888 is in use)`);
        }

        server.on('error', (err) => {
          logger.error('AuthServer: Server error', err);
        });
        logger.info(`AuthServer: Listening on http://localhost:${port}`);
        return;
      } catch (error) {
        logger.debug(`AuthServer: Port ${port} is unavailable, trying next...`, error);
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
