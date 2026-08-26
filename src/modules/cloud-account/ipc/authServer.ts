import http from 'http';
import { logger } from '@/shared/logging/logger';
import { ipcContext } from '@/ipc/context';
import { escapeHtml } from '@/shared/utils/url';

const OAUTH_LOOPBACK_HOST = '127.0.0.1';

export class AuthServer {
  private static server: http.Server | null = null;
  private static PORT = 8888;

  static async start() {
    if (this.server) {
      logger.warn('AuthServer: Server already running');
      return;
    }

    const tryPorts = [8888, 8889, 8890, 8891, 8892];
    let boundPort: number | null = null;

    for (const port of tryPorts) {
      try {
        await new Promise<void>((resolve, reject) => {
          const testServer = http.createServer();
          testServer.once('error', reject);
          testServer.listen(port, OAUTH_LOOPBACK_HOST, () => {
            testServer.close(() => resolve());
          });
        });
        boundPort = port;
        break;
      } catch {
        logger.debug(`AuthServer: Port ${port} is in use, trying next...`);
      }
    }

    if (!boundPort) {
      logger.error('AuthServer: No available ports found for OAuth callback server');
      return;
    }

    if (boundPort !== 8888) {
      logger.warn(`AuthServer: Using fallback port ${boundPort} (default 8888 is in use)`);
    }

    this.PORT = boundPort;

    try {
      this.server = http.createServer((req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { Allow: 'GET' });
          res.end('Method Not Allowed');
          return;
        }

        const url = new URL(req.url || '', `http://${OAUTH_LOOPBACK_HOST}:${this.PORT}`);

        if (url.pathname === '/oauth-callback') {
          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');

          if (code) {
            const escapedCode = escapeHtml(code);
            logger.info(
              `AuthServer: Received authorization code: ${escapedCode.substring(0, 10)}...`,
            );

            if (!ipcContext.mainWindow) {
              logger.error('AuthServer: Main window not found, cannot deliver authorization code');
              res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(`
            <html>
              <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
                <h1>Login Failed</h1>
                <p>Antigravity Manager is not ready to receive the authorization result. Return to the app and try again.</p>
              </body>
            </html>
          `);
              return;
            }

            logger.info('AuthServer: Sending code to renderer via IPC');
            ipcContext.mainWindow.webContents.send('GOOGLE_AUTH_CODE', code);
            logger.info('AuthServer: Code sent successfully');

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
      });

      this.server.on('error', (err) => {
        logger.error('AuthServer: Server error', err);
      });

      this.server.listen(this.PORT, OAUTH_LOOPBACK_HOST, () => {
        logger.info(`AuthServer: Listening on http://${OAUTH_LOOPBACK_HOST}:${this.PORT}`);
      });
    } catch (e) {
      logger.error('AuthServer: Failed to create or start server', e);
      if (this.server) {
        this.server.close();
        this.server = null;
      }
    }
  }

  static getRedirectUri(): string {
    return `http://${OAUTH_LOOPBACK_HOST}:${this.PORT}/oauth-callback`;
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
