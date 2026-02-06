import { z } from 'zod';
import { logger } from './logger';

interface StatementGet {
  get: (...args: unknown[]) => unknown;
}

interface StatementAll {
  all: (...args: unknown[]) => unknown[];
}

function logSchemaIssues(context: string, issues: z.core.$ZodIssue[]): void {
  logger.warn('SQLite row failed schema validation', {
    context,
    issues,
  });
}

export function parseRow<T extends z.ZodTypeAny>(
  schema: T,
  row: unknown,
  context: string,
): z.infer<T> | null {
  if (!row) {
    return null;
  }
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    logSchemaIssues(context, parsed.error.issues);
    return null;
  }
  return parsed.data;
}

export function parseRows<T extends z.ZodTypeAny>(
  schema: T,
  rows: unknown[],
  context: string,
): z.infer<T>[] {
  const parsed: z.infer<T>[] = [];
  for (const row of rows) {
    const parsedRow = parseRow(schema, row, context);
    if (parsedRow) {
      parsed.push(parsedRow);
    }
  }
  return parsed;
}

export function parseRowFromStatement<T extends z.ZodTypeAny>(
  stmt: StatementGet,
  schema: T,
  context: string,
  params: unknown[] = [],
): z.infer<T> | null {
  const row: unknown = stmt.get(...params);
  return parseRow(schema, row, context);
}

export function parseRowsFromStatement<T extends z.ZodTypeAny>(
  stmt: StatementAll,
  schema: T,
  context: string,
  params: unknown[] = [],
): z.infer<T>[] {
  const rows: unknown[] = stmt.all(...params);
  return parseRows(schema, rows, context);
}
