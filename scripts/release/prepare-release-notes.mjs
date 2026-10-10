import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { collectReleaseData, repositoryName, ReleaseDataSchema } from './github-release-data.mjs';
import { sourceCommits, resolveHead, git, verifyReviewedRange } from './release-source.mjs';
import { DocumentSchema, readDocument, renderReleaseDocument } from './release-document.mjs';

function areaFor(subject) {
  if (/^docs(?:\(|:)/.test(subject)) {
    return 'documentation';
  }
  if (/security|credential|signatur|authentication/i.test(subject)) {
    return 'security';
  }
  if (/proxy|gateway|schema/i.test(subject)) {
    return 'gateway';
  }
  if (/cloud-account|account|oauth/i.test(subject)) {
    return 'core';
  }
  if (/app-shell|update|desktop|runtime/i.test(subject)) {
    return 'desktop';
  }
  return 'tooling';
}

export function createDraft(version, data) {
  const groups = new Map();
  for (const commit of data.commits) {
    const area = areaFor(commit.subject);
    const items = groups.get(area) || [];
    items.push({ title: commit.subject, text: '', references: [`commit:${commit.hash}`] });
    groups.set(area, items);
  }
  return {
    schemaVersion: 1,
    version,
    reviewed: false,
    source: { baseTag: data.baseTag, headSha: data.headSha },
    overview: '',
    highlights: [],
    sections: [...groups].map(([area, items]) => ({ area, items })),
    upgradeNotes: [],
  };
}

async function save(file, contents) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  // Draft/preview commands must not silently replace an already edited release document.
  await writeFile(file, contents, { flag: 'wx' });
}

export function createReleaseNotesCommand() {
  const program = new Command().name('release-notes');
  program
    .command('draft')
    .option('--base <tag>', 'Previous semantic-release tag; omit for the first release')
    .option('--head <ref>', 'Source ref', 'HEAD')
    .requiredOption('--version <version>', 'Expected semantic version')
    .requiredOption(
      '--output <file>',
      'JSON draft; the companion .source.json stores verified facts',
    )
    .option('--branch <name>', 'Release branch', 'main')
    .option('--anonymous', 'Use public GitHub metadata without shell authentication')
    .option(
      '--local',
      'Allow unpushed commits in a local draft, with attribution marked incomplete',
    )
    .action(async (options) => {
      const cwd = process.cwd();
      DocumentSchema.shape.version.parse(options.version);
      const headSha = resolveHead(cwd, options.head);
      const baseTag = options.base || null;
      const commits = sourceCommits(cwd, baseTag, headSha, options.version);
      const data = await collectReleaseData({
        repository: repositoryName(git(cwd, ['config', '--get', 'remote.origin.url'])),
        baseTag,
        headSha,
        commits,
        branch: options.branch,
        env: options.anonymous ? {} : process.env,
        allowLocal: options.local,
      });
      await save(`${options.output}.source.json`, `${JSON.stringify(data, null, 2)}\n`);
      await save(
        options.output,
        `${JSON.stringify(createDraft(options.version, data), null, 2)}\n`,
      );
      process.stdout.write(
        `Draft saved: ${options.output}\nReview the overview, highlights and domain entries, then set reviewed to true.\n`,
      );
    });
  program
    .command('preview')
    .requiredOption('--document <file>', 'Reviewed release document')
    .requiredOption('--data <file>', 'Companion verified source JSON')
    .requiredOption('--output <file>', 'Markdown preview')
    .option('--head <ref>', 'Current source ref', 'HEAD')
    .option('--date <date>', 'ISO preview date')
    .action(async (options) => {
      const document = await readDocument(options.document);
      const data = ReleaseDataSchema.parse(JSON.parse(await readFile(options.data, 'utf8')));
      const head = resolveHead(process.cwd(), options.head);
      const commits = verifyReviewedRange(process.cwd(), document.source, head, document.version);
      if (
        data.baseTag !== document.source.baseTag ||
        data.headSha !== document.source.headSha ||
        JSON.stringify(data.commits.map((commit) => commit.hash)) !==
          JSON.stringify(commits.map((commit) => commit.hash))
      ) {
        throw new Error('Preview facts do not match the reviewed release range.');
      }
      if (options.date && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
        throw new Error('Preview date must use YYYY-MM-DD.');
      }
      await save(options.output, `${renderReleaseDocument(document, data, options.date)}\n`);
      process.stdout.write(`Preview saved: ${options.output}\n`);
    });
  return program;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await createReleaseNotesCommand().parseAsync(process.argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
