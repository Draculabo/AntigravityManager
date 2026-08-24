import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../shared/platform/paths', async () => {
  const path = await import('path');
  return {
    getAgentDir: vi.fn(() => path.join(process.cwd(), 'temp_test_logs')),
  };
});

describe('Logger Utilities', () => {
  const testLogDir = path.join(process.cwd(), 'temp_test_logs');
  let logger: {
    info: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
    setErrorReportingEnabled: (enabled: boolean) => void;
    setSentryReporter: (reporter: ((payload: unknown) => void) | null) => void;
    enableFileLogging: (directory?: string) => void;
  };

  const getLatestLogFile = () => {
    const files = fs
      .readdirSync(testLogDir)
      .filter((file) => /^app-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(file))
      .sort();

    if (files.length === 0) {
      return null;
    }

    return path.join(testLogDir, files[files.length - 1]);
  };

  const waitForLogContains = async (text: string) => {
    for (let i = 0; i < 100; i++) {
      const filePath = getLatestLogFile();
      if (filePath && fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.includes(text)) {
          return filePath;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return null;
  };

  beforeAll(async () => {
    if (fs.existsSync(testLogDir)) {
      fs.rmSync(testLogDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testLogDir, { recursive: true });
    const loggerModule = await import('../../shared/logging/logger');
    logger = loggerModule.logger;
    logger.enableFileLogging(testLogDir);
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logger.setErrorReportingEnabled(false);
    logger.setSentryReporter(null);
    vi.restoreAllMocks();
  });

  afterAll(() => {
    try {
      if (fs.existsSync(testLogDir)) {
        fs.rmSync(testLogDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error('afterAll: cleanup testLogDir failed', err);
    }
  });

  it('should create rotated log file', async () => {
    const message = 'Test message';
    logger.info(message);
    const filePath = await waitForLogContains(message);
    expect(filePath).not.toBeNull();
    expect(fs.existsSync(filePath as string)).toBe(true);
  });

  it('should write formatted message to file', async () => {
    const message = 'Test info message';
    logger.info(message);
    const filePath = await waitForLogContains(message);
    expect(filePath).not.toBeNull();
    const content = fs.readFileSync(filePath as string, 'utf-8');
    expect(content).toContain('[INFO]');
    expect(content).toContain(message);
  });

  it('should log error messages', async () => {
    const message = 'Test error message';
    logger.error(message);
    const filePath = await waitForLogContains(message);
    expect(filePath).not.toBeNull();
    const content = fs.readFileSync(filePath as string, 'utf-8');
    expect(content).toContain('[ERROR]');
    expect(content).toContain(message);
  });

  it('should report raw cloud account token refresh strings to Sentry', async () => {
    const reporter = vi.fn();
    const message = 'Token refresh failed for user@example.com. Please try logging in again.';

    logger.setSentryReporter(reporter);
    logger.setErrorReportingEnabled(true);
    logger.error(message, new Error(message));

    const filePath = await waitForLogContains(message);
    expect(filePath).not.toBeNull();
    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it('should not report structured non-reportable app errors to Sentry', async () => {
    const { AppError } = await import('../../shared/errors/appError');
    const reporter = vi.fn();
    const message = 'Cloud account login expired';

    logger.setSentryReporter(reporter);
    logger.setErrorReportingEnabled(true);
    logger.error(
      message,
      new AppError('CLOUD_ACCOUNT_LOGIN_EXPIRED', message, {
        messageKey: 'error.cloudAccountLoginExpired',
        reportToSentry: false,
        transportCode: 'UNAUTHORIZED',
        metadata: { accountId: 'account-1', email: 'user@example.com' },
      }),
    );

    const filePath = await waitForLogContains(message);
    expect(filePath).not.toBeNull();
    expect(reporter).not.toHaveBeenCalled();
  });
});

describe('Logger entry-point wiring', () => {
  it('turns on file logging from the Electron main entry point', () => {
    const mainSource = fs.readFileSync(path.join(process.cwd(), 'src/main.ts'), 'utf-8');
    expect(mainSource).toContain('logger.enableFileLogging()');
  });
});
