import fs from 'fs';
import path from 'path';
import { isObjectLike } from 'lodash-es';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { getAgentDir } from '@/shared/platform/paths';
import { shouldReportErrorToSentry } from '@/shared/errors/appError';
import { safeStringifyPacket, sanitizeObject } from '@/shared/security/sensitiveDataMasking';
import {
  OperationDiagnosticSchema,
  readFinalizedOperationDiagnostic,
  type OperationReport,
} from '@/shared/observability/operationDiagnostic';
import { currentOperationIdentity } from '@/shared/observability/operationScope';
import { SwitchTraceSchema } from '@/shared/observability/switchDiagnostic';
import { LocalErrorDispatch, type LocalErrorSink } from './local-error-sink';
import { maskShareableLogText } from './shareable-log-text';

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
  isolated?: boolean;
  operation?: OperationReport;
}) => string | void;

/**
 * Safely stringify an object, handling circular references
 * This prevents "Converting circular structure to JSON" errors
 * when logging objects like axios errors that contain socket references
 */
function safeStringify(obj: unknown): string {
  try {
    // The closed diagnostic schema permits safe readback booleans and repeated cause evidence.
    const diagnostic = OperationDiagnosticSchema.safeParse(obj);
    if (diagnostic.success) {
      return JSON.stringify(diagnostic.data);
    }
    const trace = SwitchTraceSchema.safeParse(obj);
    if (trace.success) {
      return JSON.stringify(trace.data);
    }
    return safeStringifyPacket(obj);
  } catch {
    return '[Unserializable]';
  }
}

class Logger {
  private readonly localErrors = new LocalErrorDispatch();
  private winstonLogger: winston.Logger;
  private recentLogs: LogEntry[] = [];
  private sentryReporter: SentryReporter | null = null;
  private sentryEnabled = false;
  private fileLoggingEnabled = false;

  constructor() {
    const consoleFormat = winston.format.combine(
      winston.format.colorize({ all: true }),
      winston.format.printf(({ level, message }) => {
        return `[${level.toUpperCase()}] ${message}`;
      }),
    );

    const consoleTransport = new winston.transports.Console({
      level: 'debug',
      format: consoleFormat,
    });

    consoleTransport.on('error', (error) => {
      console.error('Console transport error', error);
    });

    this.winstonLogger = winston.createLogger({
      level: 'debug',
      transports: [consoleTransport],
      exitOnError: false,
    });
  }

  /**
   * Turns on rotating file output. Must be called explicitly by an application entry
   * point, importing this module must stay free of filesystem side effects. Safe to
   * call more than once; only the first call adds the file transports.
   */
  enableFileLogging(directory: string = getAgentDir(), role: 'app' | 'core' = 'app'): void {
    if (this.fileLoggingEnabled) {
      return;
    }
    this.fileLoggingEnabled = true;

    if (!fs.existsSync(directory)) {
      try {
        fs.mkdirSync(directory, { recursive: true });
      } catch (e) {
        console.error('Failed to create agent directory for logs', e);
      }
    }

    for (const shareable of [false, true]) {
      const prefix = shareable ? `${role}-diagnostic` : role;
      const rotateTransport = new DailyRotateFile({
        filename: path.join(directory, `${prefix}-%DATE%.log`),
        datePattern: 'YYYY-MM-DD',
        maxSize: LOG_MAX_SIZE,
        maxFiles: LOG_RETENTION,
        zippedArchive: false,
        auditFile: path.join(directory, `.${prefix}-log-audit.json`),
        level: 'debug',
        format: winston.format.combine(
          winston.format((entry) => ((entry.shareable === true) === shareable ? entry : false))(),
          winston.format.timestamp(),
          winston.format.printf(
            ({ timestamp, level, message }) => `[${timestamp}] [${level.toUpperCase()}] ${message}`,
          ),
        ),
      });
      rotateTransport.on('error', (error) => {
        console.error('DailyRotateFile transport error', error);
      });
      this.winstonLogger.add(rotateTransport);
    }
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

  setLocalErrorSink(sink: LocalErrorSink): () => void {
    return this.localErrors.register(sink);
  }

  getLocalErrorSinkFailures(): number {
    return this.localErrors.failedCaptures;
  }

  private formatArgs(args: unknown[]): string {
    return args
      .map((arg) => (isObjectLike(arg) ? safeStringify(arg) : String(sanitizeObject(arg))))
      .join(' ');
  }

  log(level: LogLevel, message: string, ...args: unknown[]) {
    this.write(level, message, args, 'standard');
  }

  private write(
    level: LogLevel,
    message: string,
    args: unknown[],
    mode: 'standard' | 'isolated' | 'shareable',
  ) {
    const operation = currentOperationIdentity();
    const shareable = mode === 'shareable';
    const formattedArgs = this.formatArgs(
      operation &&
        !shareable &&
        !message.startsWith('Operation diagnostic ') &&
        !message.startsWith('Operation step ') &&
        !message.startsWith('Switch trace ')
        ? [...args, operation]
        : args,
    );
    const sanitizedMessage = shareable
      ? maskShareableLogText(message)
      : String(sanitizeObject(message));
    const mergedMessage = formattedArgs ? `${sanitizedMessage} ${formattedArgs}` : sanitizedMessage;
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
      shareable,
    });

    if (level === 'error') {
      this.localErrors.capture({ message: sanitizedMessage, error: this.extractError(args) });
    }

    if (
      level === 'error' &&
      this.sentryEnabled &&
      this.sentryReporter &&
      !operation &&
      shouldReportErrorToSentry(mergedMessage) &&
      !args.some((value) => readFinalizedOperationDiagnostic(value) !== null) &&
      shouldReportErrorToSentry(this.extractError(args))
    ) {
      try {
        const isolated = mode === 'isolated';
        this.sentryReporter({
          level,
          message: mergedMessage,
          error: this.extractError(args),
          logs: isolated ? [] : [...this.recentLogs],
          isolated,
        });
      } catch {
        // Reporting is best-effort and must never recursively report its own failure.
        this.winstonLogger.log({ level: 'warn', message: 'Error reporter failed' });
      }
    }
  }

  info(message: string, ...args: unknown[]) {
    this.log('info', message, ...args);
  }

  /** Report attachments retain this prose. Pass only app-owned text and approved fields. */
  shareable(level: 'info' | 'warn', message: string): void {
    this.write(level, message, [], 'shareable');
  }

  warn(message: string, ...args: unknown[]) {
    this.log('warn', message, ...args);
  }

  error(message: string, ...args: unknown[]) {
    this.log('error', message, ...args);
  }

  diagnosticError(message: string): void {
    this.write('error', message, [], 'isolated');
  }

  debug(message: string, ...args: unknown[]) {
    this.log('debug', message, ...args);
  }
}

export const logger = new Logger();
