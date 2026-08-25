import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT_AGENT_LINE_LIMIT = 180;

const REQUIRED_FILES = [
  'AGENTS.md',
  'docs/AGENTS.md',
  'docs/architecture.md',
  'docs/development.md',
  'docs/security.md',
  'docs/testing.md',
  'src/modules/AGENTS.md',
  'src/modules/proxy-gateway/AGENTS.md',
  'src/shared/persistence/AGENTS.md',
  '.agents/notes/README.md',
  '.agents/skills/agm-validate-change/SKILL.md',
];

const NOTE_REQUIRED_SECTIONS = {
  proposed: ['Problem', 'Proposal', 'Alternatives considered', 'Acceptance criteria', 'Risks'],
  implemented: ['Problem', 'Decision', 'Alternatives considered', 'Consequences', 'Verification'],
  rejected: ['Problem', 'Proposal', 'Alternatives considered'],
};

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

function governanceFiles(rootDir) {
  const explicitFiles = REQUIRED_FILES.map((file) => path.join(rootDir, file)).filter(existsSync);
  const noteFiles = collectMarkdownFiles(path.join(rootDir, '.agents', 'notes'));

  return [...new Set([...explicitFiles, ...noteFiles])].sort();
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
    ...content.matchAll(/\bnpm\s+run\s+([a-zA-Z0-9:_-]+)\b/g),
    ...content.matchAll(/\bnpm\s+(start|test)\b/g),
  ].map((match) => match[1]);

  for (const scriptName of referencedScripts) {
    if (!(scriptName in packageScripts)) {
      errors.push(`${relativeFile}: references missing npm script: ${scriptName}`);
    }
  }
}

function validateAgentNote(rootDir, filePath, errors) {
  const notesRoot = path.join(rootDir, '.agents', 'notes');
  const relativeToNotes = toPosixPath(path.relative(notesRoot, filePath));

  if (relativeToNotes === 'README.md') {
    return;
  }

  const [lifecycle] = relativeToNotes.split('/');

  if (!(lifecycle in NOTE_REQUIRED_SECTIONS)) {
    errors.push(`${relativeToNotes}: Agent Note must be under proposed, implemented or rejected`);
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

  for (const filePath of governanceFiles(resolvedRoot)) {
    const content = readText(filePath);
    validateMarkdownLinks(resolvedRoot, filePath, content, errors);
    validateReferencedScripts(resolvedRoot, filePath, content, packageScripts, errors);

    if (filePath.startsWith(path.join(resolvedRoot, '.agents', 'notes'))) {
      validateAgentNote(resolvedRoot, filePath, errors);
    }
  }

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
