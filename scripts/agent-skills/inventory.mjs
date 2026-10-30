import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const text = z.string().trim().min(1);
const relativePath = text.refine(
  (value) =>
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !value.includes(':') &&
    value.split('/').every((part) => part !== '..' && part !== '.' && part !== ''),
  'Expected a repository-relative POSIX path',
);
const policySchema = z
  .object({
    version: z.literal(1),
    roots: z.array(relativePath).min(1),
    origins: z.array(z.object({ path: relativePath, owner: text }).strict()),
    mirrors: z.array(
      z
        .object({
          roots: z.array(relativePath).min(2),
          prefix: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*-$/),
          owner: text,
          reason: text,
          removeWhen: text,
        })
        .strict(),
    ),
  })
  .strict();
const metadataSchema = z.object({
  name: text,
  description: text,
  metadata: z.object({ author: text.optional(), generatedBy: text.optional() }).optional(),
});

function readText(file) {
  if (statSync(file).size > 1024 * 1024) {
    throw new Error('document exceeds the 1 MiB inspection limit');
  }
  return readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
}

/** Resolve an existing managed path without following links outside the repository. */
export function managedPath(rootDir, relative) {
  const root = realpathSync(rootDir);
  const target = path.resolve(root, relative);
  const actual = realpathSync(target);
  const fromRoot = path.relative(root, actual);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error('managed path resolves outside the repository');
  }
  return actual;
}

export function readSkillPolicy(rootDir) {
  const file = 'scripts/agent-skills/policy.json';
  const policy = policySchema.parse(JSON.parse(readText(managedPath(rootDir, file))));
  if (new Set(policy.roots).size !== policy.roots.length) {
    throw new Error('skill roots must be unique');
  }
  const originPaths = new Set();
  for (const origin of policy.origins) {
    if (
      !policy.roots.some(
        (root) =>
          origin.path.startsWith(`${root}/`) && !origin.path.slice(root.length + 1).includes('/'),
      ) ||
      originPaths.has(origin.path)
    ) {
      throw new Error('origin overrides must identify unique skills in a managed root');
    }
    originPaths.add(origin.path);
  }
  for (const mirror of policy.mirrors) {
    if (
      new Set(mirror.roots).size !== mirror.roots.length ||
      mirror.roots.some((root) => !policy.roots.includes(root))
    ) {
      throw new Error('mirror roots must be distinct managed roots');
    }
  }
  return policy;
}

function readMetadata(content) {
  const header = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!header) {
    throw new Error('missing YAML frontmatter');
  }
  const document = parseDocument(header[1]);
  if (document.errors.length > 0) {
    throw new Error('invalid YAML frontmatter');
  }
  const result = metadataSchema.safeParse(document.toJS());
  if (!result.success) {
    throw new Error('frontmatter needs non-empty name and description and valid optional metadata');
  }
  return result.data;
}

/** Inspect entry documents only; empty harness directories are not installed skills. */
export function collectSkillInventory(rootDir, policy) {
  const skills = [];
  const errors = [];
  for (const root of policy.roots) {
    try {
      const directory = managedPath(rootDir, root);
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          continue;
        }
        const skillPath = `${root}/${entry.name}`;
        const file = `${skillPath}/SKILL.md`;
        try {
          const skillDirectory = managedPath(rootDir, skillPath);
          if (!existsSync(path.join(skillDirectory, 'SKILL.md'))) {
            continue;
          }
          const realFile = managedPath(rootDir, file);
          const content = readText(realFile);
          const metadata = readMetadata(content);
          const override = policy.origins.find((origin) => origin.path === skillPath);
          const generatedBy = metadata.metadata?.generatedBy;
          const author = metadata.metadata?.author;
          skills.push({
            path: file,
            root,
            slug: entry.name,
            realFile,
            content,
            name: metadata.name,
            description: metadata.description,
            lines: content.trimEnd().split('\n').length,
            source: generatedBy ? 'generated' : override || author ? 'upstream' : 'project',
            owner: override?.owner ?? author ?? 'Antigravity Manager',
            generatedBy: generatedBy ?? null,
          });
        } catch (error) {
          errors.push(`${file}: ${error.message}`);
        }
      }
    } catch (error) {
      errors.push(`${root}: ${error.message}`);
    }
  }
  for (const origin of policy.origins) {
    if (!skills.some((skill) => skill.path === `${origin.path}/SKILL.md`)) {
      errors.push(`${origin.path}: origin override has no valid skill entry`);
    }
  }
  return { skills, errors };
}
