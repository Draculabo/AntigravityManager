import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { managedPath } from '../agent-skills/inventory.mjs';

const text = z.string().trim().min(1);
const texts = z.array(text).min(1);
const corpusSchema = z
  .object({
    version: z.literal(1),
    cases: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
            context: text,
            messages: z
              .array(z.object({ role: z.enum(['user', 'assistant']), text }).strict())
              .min(1),
            acceptedRoutes: texts,
            requiredActions: texts,
            prohibitedActions: texts,
            sources: texts,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** Validate fixtures, never infer whether an Agent followed their rubric. */
export function validateRoutingCases(rootDir) {
  const relative = 'scripts/agent-routing/cases.json';
  let corpus;
  try {
    const file = managedPath(rootDir, relative);
    if (statSync(file).size > 1024 * 1024) {
      throw new Error('corpus exceeds the 1 MiB inspection limit');
    }
    corpus = corpusSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    return [`${relative}: ${error.message}`];
  }
  const errors = [];
  const ids = new Set();
  for (const item of corpus.cases) {
    if (ids.has(item.id)) {
      errors.push(`${relative}: duplicate case id ${item.id}`);
    }
    ids.add(item.id);
    if (item.messages.at(-1).role !== 'user') {
      errors.push(`${relative}: ${item.id} must end with a user request`);
    }
    for (const source of item.sources) {
      if (
        source.includes('\\') ||
        source.includes(':') ||
        source.startsWith('/') ||
        source.split('/').some((part) => part === '..' || part === '.' || part === '')
      ) {
        errors.push(`${relative}: ${item.id} has a non-relative source ${source}`);
        continue;
      }
      try {
        if (!statSync(managedPath(rootDir, source)).isFile()) {
          throw new Error('source is not a file');
        }
      } catch (error) {
        errors.push(`${relative}: ${item.id} source ${source}: ${error.message}`);
      }
    }
  }
  return errors;
}
