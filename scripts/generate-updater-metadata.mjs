import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import semver from 'semver';
import { z } from 'zod';

const repositoryUrl = 'https://github.com/Draculabo/AntigravityManager';
const releaseSchema = z.object({
  tagName: z
    .string()
    .max(128)
    .refine((tag) => tag.startsWith('v') && semver.valid(tag.slice(1)) !== null),
  body: z
    .string()
    .max(256 * 1024)
    .nullable(),
  publishedAt: z.iso.datetime().nullable(),
  url: z.url(),
});

/** Serialize the published description as JSON rather than interpolating Markdown into shell code. */
export function buildUpdaterMetadata(release) {
  const parsed = releaseSchema.parse(release);
  const releaseUrl = `${repositoryUrl}/releases/tag/${parsed.tagName}`;
  if (parsed.url !== releaseUrl) {
    throw new Error('Release URL does not match the selected repository and tag');
  }
  return {
    version: parsed.tagName.slice(1),
    notes: parsed.body ?? '',
    pub_date: parsed.publishedAt ?? new Date().toISOString(),
    url: releaseUrl,
  };
}

function runCli() {
  const { values } = parseArgs({
    options: { 'release-file': { type: 'string' }, output: { type: 'string' } },
  });
  if (!values['release-file'] || !values.output) {
    throw new Error('--release-file and --output are required');
  }
  if (statSync(values['release-file']).size > 2 * 1024 * 1024) {
    throw new Error('Release JSON exceeds the metadata input limit');
  }
  const metadata = buildUpdaterMetadata(JSON.parse(readFileSync(values['release-file'], 'utf8')));
  mkdirSync(path.dirname(values.output), { recursive: true });
  writeFileSync(values.output, `${JSON.stringify(metadata, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
