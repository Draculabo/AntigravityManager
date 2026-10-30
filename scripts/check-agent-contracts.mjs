import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { validateDocumentLifecycle } from './agent-document-lifecycle.mjs';
import { validateRoutingCases } from './agent-routing/contracts.mjs';
import { inspectSkills } from './agent-skills/contracts.mjs';

export const ROOT_AGENT_LINE_LIMIT = 180;

const REQUIRED_FILES = [
  'AGENTS.md',
  'docs/AGENTS.md',
  'docs/architecture.md',
  'docs/development.md',
  'docs/security.md',
  'docs/testing.md',
  'docs/error-handling.md',
  'docs/test-reliability.md',
  'docs/development/agent-skills.md',
  'docs/testing/agent-routing.md',
  'docs/upgrade-guides/README.md',
  'scripts/AGENTS.md',
  'scripts/README.md',
  'lefthook.yml',
  'src/modules/AGENTS.md',
  'src/modules/proxy-gateway/AGENTS.md',
  'src/shared/persistence/AGENTS.md',
  '.agents/notes/README.md',
  '.agents/lessons.md',
  '.agents/skills/agm-code-review/SKILL.md',
  '.agents/skills/agm-validate-change/SKILL.md',
];

const NOTE_REQUIRED_SECTIONS = {
  proposed: ['Problem', 'Proposal', 'Alternatives considered', 'Acceptance criteria', 'Risks'],
  implemented: ['Problem', 'Decision', 'Alternatives considered', 'Consequences', 'Verification'],
  rejected: ['Problem', 'Proposal', 'Alternatives considered'],
};

const LESSON_REQUIRED_SECTIONS = [
  'When to capture',
  'Candidate format',
  'Promotion',
  'Active candidates',
];
const LESSON_REQUIRED_FIELDS = [
  'Rule',
  'Evidence',
  'Cause',
  'Prevention',
  'Occurrences',
  'Owner',
  'Since',
  'Applies while',
];

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function readText(filePath) {
  return readFileSync(filePath, 'utf8').replaceAll('\r\n', '\n');
}

function collectMarkdownFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }

  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath);
    }
  }

  return files;
}

function governanceFiles(rootDir, skillFiles) {
  // Skill bodies enter only after inventory has validated their resolved paths.
  const explicitFiles = REQUIRED_FILES.filter((file) => !file.endsWith('/SKILL.md'))
    .map((file) => path.join(rootDir, file))
    .filter(existsSync);
  const noteFiles = collectMarkdownFiles(path.join(rootDir, '.agents', 'notes'));
  const guideFiles = collectMarkdownFiles(path.join(rootDir, 'docs', 'upgrade-guides'));

  return [...new Set([...explicitFiles, ...noteFiles, ...guideFiles, ...skillFiles])].sort();
}

function validateMarkdownLinks(rootDir, filePath, content, errors) {
  const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (const match of content.matchAll(linkPattern)) {
    const rawTarget = match[1].replace(/^<|>$/g, '');

    if (/^(?:https?:|mailto:)/.test(rawTarget) || rawTarget.startsWith('#')) {
      continue;
    }

    const targetWithoutFragment = rawTarget.split('#', 1)[0].split('?', 1)[0];

    if (!targetWithoutFragment) {
      continue;
    }

    const relativeFile = toPosixPath(path.relative(rootDir, filePath));

    if (path.isAbsolute(targetWithoutFragment)) {
      errors.push(`${relativeFile}: repository Markdown links must be relative: ${rawTarget}`);
      continue;
    }

    let decodedTarget;

    try {
      decodedTarget = decodeURIComponent(targetWithoutFragment);
    } catch {
      errors.push(`${relativeFile}: invalid URL encoding in Markdown link: ${rawTarget}`);
      continue;
    }

    const resolvedTarget = path.resolve(path.dirname(filePath), decodedTarget);

    if (!existsSync(resolvedTarget)) {
      errors.push(`${relativeFile}: missing local link target: ${rawTarget}`);
    }
  }
}

function validateReferencedScripts(rootDir, filePath, content, packageScripts, errors) {
  const relativeFile = toPosixPath(path.relative(rootDir, filePath));
  const referencedScripts = [
    ...content.matchAll(/\bpnpm\s+run\s+([a-zA-Z0-9:_-]+)\b/g),
    ...content.matchAll(/\bpnpm\s+(start|test)\b/g),
  ].map((match) => match[1]);

  for (const scriptName of referencedScripts) {
    if (!(scriptName in packageScripts)) {
      errors.push(`${relativeFile}: references missing pnpm script: ${scriptName}`);
    }
  }
}

function validateAgentNote(rootDir, filePath, errors) {
  const notesRoot = path.join(rootDir, '.agents', 'notes');
  const relativeToNotes = toPosixPath(path.relative(notesRoot, filePath));

  if (relativeToNotes === 'README.md') {
    return;
  }

  const [directory] = relativeToNotes.split('/');
  const lifecycle = directory === 'archived' ? 'implemented' : directory;

  if (!(lifecycle in NOTE_REQUIRED_SECTIONS)) {
    errors.push(
      `${relativeToNotes}: Agent Note must be under proposed, implemented, rejected or archived`,
    );
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(path.basename(filePath))) {
    errors.push(`${relativeToNotes}: Agent Note filename must start with yyyy-mm-dd-`);
  }

  const content = readText(filePath);
  const lines = content.split('\n');

  if (!lines[0]?.startsWith('# Agent Note: ')) {
    errors.push(`${relativeToNotes}: first line must start with "# Agent Note: "`);
  }

  const status = content.match(/^Status:\s*(.+)$/m)?.[1];
  const statusMatches =
    status === lifecycle ||
    (lifecycle === 'rejected' && status?.startsWith('rejected — ') === true);

  if (!statusMatches) {
    errors.push(`${relativeToNotes}: status must match lifecycle "${lifecycle}"`);
  }

  const headings = new Set([...content.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1]));

  for (const section of NOTE_REQUIRED_SECTIONS[lifecycle]) {
    if (!headings.has(section)) {
      errors.push(`${relativeToNotes}: missing required section "## ${section}"`);
    }
  }
}

function validateAgentLessons(rootDir, errors) {
  const relativeFile = '.agents/lessons.md';
  const filePath = path.join(rootDir, relativeFile);
  if (!existsSync(filePath)) {
    return;
  }

  const content = readText(filePath);
  const headings = new Set([...content.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1]));
  for (const section of LESSON_REQUIRED_SECTIONS) {
    if (!headings.has(section)) {
      errors.push(`${relativeFile}: missing required section "## ${section}"`);
    }
  }

  const rootAgentPath = path.join(rootDir, 'AGENTS.md');
  if (existsSync(rootAgentPath) && !readText(rootAgentPath).includes('(.agents/lessons.md)')) {
    errors.push('AGENTS.md must link triggered failure reviews to .agents/lessons.md');
  }

  const sectionStart = content.indexOf('## Active candidates');
  if (sectionStart < 0) {
    return;
  }
  const bodyStart = content.indexOf('\n', sectionStart) + 1;
  const nextSection = content.indexOf('\n## ', bodyStart);
  const activeBody = content.slice(bodyStart, nextSection < 0 ? content.length : nextSection);
  const entries = [...activeBody.matchAll(/^### Candidate: ([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/gm)];
  const seen = new Set();

  if (entries.length === 0 && !/^No active candidates\.$/m.test(activeBody)) {
    errors.push(`${relativeFile}: empty candidate section must state "No active candidates."`);
  }
  if (entries.length > 0 && /^No active candidates\.$/m.test(activeBody)) {
    errors.push(`${relativeFile}: remove "No active candidates." when entries are present`);
  }

  for (const [index, entry] of entries.entries()) {
    const slug = entry[1];
    if (seen.has(slug)) {
      errors.push(`${relativeFile}: duplicate candidate slug "${slug}"`);
    }
    seen.add(slug);

    const entryStart = entry.index + entry[0].length;
    const entryEnd = entries[index + 1]?.index ?? activeBody.length;
    const candidate = activeBody.slice(entryStart, entryEnd);
    for (const field of LESSON_REQUIRED_FIELDS) {
      const fieldPattern = new RegExp(`^- \\*\\*${field}:\\*\\*[ \\t]*\\S`, 'm');
      if (!fieldPattern.test(candidate)) {
        errors.push(`${relativeFile}: candidate "${slug}" needs a non-empty ${field} field`);
      }
    }
    const since = candidate.match(/^- \*\*Since:\*\*[ \t]*([^\r\n]*)/m)?.[1].trim();
    if (since && !z.iso.date().safeParse(since).success) {
      errors.push(`${relativeFile}: candidate "${slug}" Since must be a valid YYYY-MM-DD date`);
    }
  }
}

/**
 * Validate the repository's mechanically decidable agent-governance contracts.
 *
 * @param {string} rootDir absolute or relative repository root
 * @returns {{ errors: string[] }} validation result
 */
export function validateAgentContracts(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const errors = [];

  for (const relativeFile of REQUIRED_FILES) {
    if (!existsSync(path.join(resolvedRoot, relativeFile))) {
      errors.push(`missing required governance file: ${relativeFile}`);
    }
  }

  const rootAgentPath = path.join(resolvedRoot, 'AGENTS.md');

  if (existsSync(rootAgentPath)) {
    const lineCount = readText(rootAgentPath).trimEnd().split('\n').length;

    if (lineCount > ROOT_AGENT_LINE_LIMIT) {
      errors.push(`AGENTS.md exceeds ${ROOT_AGENT_LINE_LIMIT} lines: ${lineCount}`);
    }
  }

  const packagePath = path.join(resolvedRoot, 'package.json');
  let packageScripts = {};

  if (!existsSync(packagePath)) {
    errors.push('missing package.json');
  } else {
    try {
      packageScripts = JSON.parse(readText(packagePath)).scripts ?? {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`package.json is not valid JSON: ${message}`);
    }
  }

  const skillReport = inspectSkills(resolvedRoot);
  errors.push(...skillReport.errors);
  const projectSkillFiles = skillReport.skills
    .filter((skill) => skill.source === 'project')
    .map((skill) => path.join(resolvedRoot, skill.path));
  for (const filePath of governanceFiles(resolvedRoot, projectSkillFiles)) {
    const content = readText(filePath);
    const archived =
      path.relative(path.join(resolvedRoot, '.agents', 'notes'), filePath).split(path.sep)[0] ===
      'archived';
    if (!archived) {
      validateMarkdownLinks(resolvedRoot, filePath, content, errors);
      validateReferencedScripts(resolvedRoot, filePath, content, packageScripts, errors);
    }

    if (filePath.startsWith(path.join(resolvedRoot, '.agents', 'notes'))) {
      validateAgentNote(resolvedRoot, filePath, errors);
    }
  }

  validateAgentLessons(resolvedRoot, errors);
  errors.push(...validateRoutingCases(resolvedRoot));

  errors.push(
    ...validateDocumentLifecycle(
      resolvedRoot,
      collectMarkdownFiles(path.join(resolvedRoot, '.agents', 'notes')),
      collectMarkdownFiles(path.join(resolvedRoot, 'docs', 'upgrade-guides')),
    ),
  );

  return { errors };
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  const rootDir = process.argv[2] ?? path.resolve(import.meta.dirname, '..');
  const result = validateAgentContracts(rootDir);

  if (result.errors.length > 0) {
    console.error('Agent contract validation failed:');

    for (const error of result.errors) {
      console.error(`- ${error}`);
    }

    process.exitCode = 1;
  } else {
    console.log('Agent contract validation passed.');
  }
}
