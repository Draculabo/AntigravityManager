import http from 'http';
import { logger } from '../../utils/logger';
import { ipcContext } from '../context';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class AuthServer {
  private static server: http.Server | null = null;
  private static PORT = 8888;

  static start() {
    if (this.server) {
      logger.warn('AuthServer: Server already running');
      return;
    }

    this.server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://localhost:${this.PORT}`);

      if (url.pathname === '/oauth-callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (code) {
          logger.info(`AuthServer: Received authorization code: ${code.substring(0, 10)}...`);

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
          logger.error(`AuthServer: OAuth error: ${error}`);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html>
              <body>
                <h1>Login Failed</h1>
                <p>Error: ${escapeHtml(error)}</p>
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

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        this.server = null;
        logger.warn(
          `AuthServer: Port ${this.PORT} is in use. Another instance may be running. OAuth login will not work until you close other instances.`,
        );
      } else {
        logger.error('AuthServer: Server error', err);
      }
    });

    this.server.listen(this.PORT, '127.0.0.1', () => {
      logger.info(`AuthServer: Listening on http://localhost:${this.PORT}`);
    });
  }

  static stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      logger.info('AuthServer: Stopped');
    }
  }
}
