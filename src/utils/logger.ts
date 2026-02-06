import fs from 'fs';
import path from 'path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { getAgentDir } from './paths';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const LOG_WINDOW_MS = 30_000;
const MAX_LOG_ENTRIES = 200;
const LOG_RETENTION = '30d';
const LOG_MAX_SIZE = '10m';

interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  formatted: string;
}

type SentryReporter = (payload: {
  level: LogLevel;
  message: string;
  error?: Error;
  logs: LogEntry[];
}) => void;

/**
 * Safely stringify an object, handling circular references
 * This prevents "Converting circular structure to JSON" errors
 * when logging objects like axios errors that contain socket references
 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    // Handle Error objects specially
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }
    // Handle circular references
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  });
}

class Logger {
  private winstonLogger: winston.Logger;
  private recentLogs: LogEntry[] = [];
  private sentryReporter: SentryReporter | null = null;
  private sentryEnabled = false;

  constructor() {
    const agentDir = getAgentDir();

    if (!fs.existsSync(agentDir)) {
      try {
        fs.mkdirSync(agentDir, { recursive: true });
      } catch (e) {
        console.error('Failed to create agent directory for logs', e);
      }
    }

    const fileFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf(({ timestamp, level, message }) => {
        return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
      }),
    );

    const consoleFormat = winston.format.combine(
      winston.format.colorize({ all: true }),
      winston.format.printf(({ level, message }) => {
        return `[${level.toUpperCase()}] ${message}`;
      }),
    );

    const rotateTransport = new DailyRotateFile({
      filename: path.join(agentDir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: LOG_MAX_SIZE,
      maxFiles: LOG_RETENTION,
      zippedArchive: false,
      auditFile: path.join(agentDir, '.app-log-audit.json'),
      level: 'debug',
      format: fileFormat,
    });

    rotateTransport.on('error', (error) => {
      console.error('DailyRotateFile transport error', error);
    });

    const consoleTransport = new winston.transports.Console({
      level: 'debug',
      format: consoleFormat,
    });

    consoleTransport.on('error', (error) => {
      console.error('Console transport error', error);
    });

    this.winstonLogger = winston.createLogger({
      level: 'debug',
      transports: [consoleTransport, rotateTransport],
      exitOnError: false,
    });
  }

  private pruneLogs(now: number) {
    while (this.recentLogs.length > 0 && now - this.recentLogs[0].timestamp > LOG_WINDOW_MS) {
      this.recentLogs.shift();
    }

    if (this.recentLogs.length > MAX_LOG_ENTRIES) {
      this.recentLogs = this.recentLogs.slice(-MAX_LOG_ENTRIES);
    }
  }

  private extractError(args: unknown[]): Error | undefined {
    for (const arg of args) {
      if (arg instanceof Error) {
        return arg;
      }
    }
    return undefined;
  }

  setSentryReporter(reporter: SentryReporter | null) {
    this.sentryReporter = reporter;
  }

  setErrorReportingEnabled(enabled: boolean) {
    this.sentryEnabled = enabled;
  }

  private formatArgs(args: unknown[]): string {
    return args
      .map((arg) => (typeof arg === 'object' ? safeStringify(arg) : String(arg)))
      .join(' ');
  }

  log(level: LogLevel, message: string, ...args: unknown[]) {
    const formattedArgs = this.formatArgs(args);
    const mergedMessage = formattedArgs ? `${message} ${formattedArgs}` : message;
    const now = Date.now();
    const formattedMessage = `[${new Date(now).toISOString()}] [${level.toUpperCase()}] ${mergedMessage}`;

    this.recentLogs.push({
      timestamp: now,
      level,
      message: mergedMessage,
      formatted: formattedMessage,
    });
    this.pruneLogs(now);

    this.winstonLogger.log({
      level,
      message: mergedMessage,
    });

    if (level === 'error' && this.sentryEnabled && this.sentryReporter) {
      this.sentryReporter({
        level,
        message: mergedMessage,
        error: this.extractError(args),
        logs: [...this.recentLogs],
      });
    }
  }

  info(message: string, ...args: unknown[]) {
    this.log('info', message, ...args);
  }

  warn(message: string, ...args: unknown[]) {
    this.log('warn', message, ...args);
  }

  error(message: string, ...args: unknown[]) {
    this.log('error', message, ...args);
  }

  debug(message: string, ...args: unknown[]) {
    this.log('debug', message, ...args);
  }
}

export const logger = new Logger();
