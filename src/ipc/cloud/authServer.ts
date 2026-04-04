import http from 'http';
import { logger } from '../../utils/logger';
import { ipcContext } from '../context';
import { escapeHtml } from '../../utils/url';

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
          testServer.listen(port, '127.0.0.1', () => {
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

        const url = new URL(req.url || '', `http://localhost:${this.PORT}`);

        if (url.pathname === '/oauth-callback') {
          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');

          if (code) {
            const escapedCode = escapeHtml(code);
            logger.info(
              `AuthServer: Received authorization code: ${escapedCode.substring(0, 10)}...`,
            );

            // Send code to renderer
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
      });

      this.server.on('error', (err) => {
        logger.error('AuthServer: Server error', err);
      });

      this.server.listen(this.PORT, '127.0.0.1', () => {
        logger.info(`AuthServer: Listening on http://localhost:${this.PORT}`);
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
    return `http://localhost:${this.PORT}/oauth-callback`;
  }

  static stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      logger.info('AuthServer: Stopped');
    }
  }
}
