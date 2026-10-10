import { os } from '@orpc/server';
import { LogReadInputSchema, LogSourceSchema, type LogSource } from './schema';

export type CoreLogReader = (until: number) => Promise<LogSource>;
export function createDiagnosticLogCoreRouter(read: CoreLogReader) {
  return os
    .input(LogReadInputSchema)
    .output(LogSourceSchema)
    .handler(({ input }) => read(input.until));
}
