import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { collectReleaseData, repositoryName } from './github-release-data.mjs';
import { sourceCommits, resolveHead, git } from './release-source.mjs';
import { DocumentSchema, renderReleaseDocument } from './release-document.mjs';
import { createAutomaticStory } from './automatic-release-story.mjs';

async function save(file, contents) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  // Preview commands must not silently replace an existing output.
  await writeFile(file, contents, { flag: 'wx' });
}

export function createReleaseNotesCommand() {
  const program = new Command().name('release-notes');
  program
    .command('preview')
    .option('--base <tag>', 'Previous semantic-release tag; omit for the first release')
    .option('--head <ref>', 'Source ref', 'HEAD')
    .requiredOption('--version <version>', 'Expected semantic version')
    .requiredOption('--output <file>', 'Markdown preview')
    .option('--date <date>', 'ISO preview date')
    .option('--branch <name>', 'Release branch', 'main')
    .option('--anonymous', 'Use public GitHub metadata without shell authentication')
    .option(
      '--local',
      'Allow unpushed commits in a local preview, with attribution marked incomplete',
    )
    .action(async (options) => {
      const cwd = process.cwd();
      DocumentSchema.shape.version.parse(options.version);
      if (options.date && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
        throw new Error('Preview date must use YYYY-MM-DD.');
      }
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
      const document = createAutomaticStory(options.version, data);
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
