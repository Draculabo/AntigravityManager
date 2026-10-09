import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Read bounded log tails, emitting only the converter's closed diagnostic fields. */
export function readLiveLocalDiagnostics(directory, since) {
  const finding = z.object({
    protocol: z.enum(['openai', 'anthropic', 'anthropic-count-tokens']),
    degraded: z.boolean(),
    issueCount: z.number().int().nonnegative(),
    issues: z.array(
      z.object({
        kind: z.enum([
          'invalid-reference',
          'reference-cycle',
          'unsupported-reference',
          'invalid-input',
          'input-budget',
          'request-budget',
          'expansion-budget',
          'invalid-root',
        ]),
        recovered: z.boolean(),
      }),
    ),
  });
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^core-\d{4}-\d{2}-\d{2}\.log(?:\.\d+)?$/.test(name))
    .map((name) => ({
      file: path.join(directory, name),
      info: fs.statSync(path.join(directory, name)),
    }))
    .filter(({ info }) => info.mtimeMs >= since)
    .sort((left, right) => right.info.mtimeMs - left.info.mtimeMs)
    .slice(0, 2);
  const diagnostics = [];
  for (const { file, info } of files) {
    const offset = Math.max(0, info.size - 2 * 1024 * 1024);
    const bytes = Buffer.alloc(info.size - offset);
    const descriptor = fs.openSync(file, 'r');
    try {
      fs.readSync(descriptor, bytes, 0, bytes.length, offset);
    } finally {
      fs.closeSync(descriptor);
    }
    for (const line of bytes.toString('utf8').split('\n')) {
      const match = /^\[([^\]]+)\] \[ERROR\] Schema conversion issue (\{.*\})$/.exec(line.trim());
      if (!match || Date.parse(match[1]) < since || !Number.isFinite(Date.parse(match[1]))) {
        continue;
      }
      let parsed;
      try {
        parsed = finding.safeParse(JSON.parse(match[2]));
      } catch {
        continue;
      }
      if (parsed.success) {
        diagnostics.push({
          protocol: parsed.data.protocol,
          degraded: parsed.data.degraded,
          issueCount: parsed.data.issueCount,
          kinds: parsed.data.issues.map((issue) => issue.kind),
          recovered: parsed.data.issues.map((issue) => issue.recovered),
        });
      }
    }
  }
  return { logFilesRead: files.length, diagnostics };
}
