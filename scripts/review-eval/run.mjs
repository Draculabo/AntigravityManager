import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { z } from 'zod';
import { CASES } from './cases.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const MAX_BYTES = 8 * 1024 * 1024;
const text = z.string().trim().min(1);
const findingSchema = z.object({
  id: text,
  file: text,
  line: z.number().int().positive(),
  trigger: text,
  impact: text,
  evidence: text,
  proposal: text,
  verdict: z.enum(['target-defect', 'other-valid', 'false-positive', 'harmful']),
  reason: text,
});
const resultSchema = z.object({
  corpusDigest: text,
  run: z.object({
    model: text,
    instructionRevision: text,
    tools: text,
    budget: text,
    adjudicator: text,
  }),
  samples: z.array(
    z.object({
      id: text,
      status: z.enum(['completed', 'unavailable']),
      response: text,
      durationMs: z.number().nonnegative(),
      tokens: z.number().int().nonnegative().nullable(),
      findings: z.array(findingSchema),
    }),
  ),
});
const manifestSchema = z.object({
  version: z.literal(1),
  instructionDigest: text,
  samples: z.array(
    z.object({
      id: text,
      caseId: text,
      variant: z.enum(['before', 'fixed']),
      revision: z.string().regex(/^[a-f0-9]{40}$/),
      files: z.array(z.object({ path: text, sha256: text })),
      rubric: text,
      evidence: text,
      preserve: text,
    }),
  ),
});

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function gitText(root, args) {
  return execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_BYTES,
    timeout: 20_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

async function readBounded(file) {
  if ((await stat(file)).size > MAX_BYTES) {
    throw new Error(`Input exceeds ${MAX_BYTES} bytes: ${file}`);
  }
  return readFile(file, 'utf8');
}

function inside(root, relative) {
  const resolved = path.resolve(root, relative);
  const remainder = path.relative(root, resolved);
  if (!remainder || remainder.startsWith('..') || path.isAbsolute(remainder)) {
    throw new Error(`Expected a child path: ${relative}`);
  }
  return resolved;
}

// The digest excludes reviewer instructions so candidates can be compared on identical source inputs.
function corpusDigest(manifest) {
  return digest(JSON.stringify(manifest.samples));
}

export async function prepare(root, output, cases = CASES) {
  const destination = path.resolve(output);
  const relative = path.relative(path.resolve(root), destination);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(
      'Prepare outside the repository to keep evaluator answers out of reviewer input.',
    );
  }
  const instructions = await readBounded(
    path.join(root, '.agents/skills/agm-code-review/SKILL.md'),
  );
  // Resolve every historical input before creating output; missing history is not an empty sample.
  const snapshots = cases.flatMap((entry) =>
    ['before', 'fixed'].map((variant) => {
      const revision = gitText(root, [
        'rev-parse',
        '--verify',
        `${entry[variant]}^{commit}`,
      ]).trim();
      const paths =
        variant === 'fixed' ? [...entry.paths, ...(entry.fixedOnlyPaths ?? [])] : entry.paths;
      const files = gitText(root, ['ls-tree', '-r', '--name-only', revision, '--', ...paths])
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((file) => ({ path: file, source: gitText(root, ['show', `${revision}:${file}`]) }));
      for (const requested of paths) {
        if (
          !files.some((file) =>
            requested.endsWith('/') ? file.path.startsWith(requested) : file.path === requested,
          )
        ) {
          throw new Error(`Missing historical input: ${revision}:${requested}`);
        }
      }
      return { entry, variant, revision, files };
    }),
  );
  await mkdir(destination);
  const manifest = { version: 1, instructionDigest: digest(instructions), samples: [] };
  for (const snapshot of snapshots) {
    const { entry, variant, revision, files } = snapshot;
    const id = digest(`${entry.id}:${revision}`).slice(0, 12);
    const sampleRoot = inside(destination, `reviewer/${id}`);
    await mkdir(sampleRoot, { recursive: true });
    await writeFile(path.join(sampleRoot, 'instructions.md'), instructions);
    await writeFile(
      path.join(sampleRoot, 'task.md'),
      `${entry.task}\n\nThis is a focused historical source audit, not a complete PR checkout. Use only this sample and instructions.md; do not access other samples, evaluator files, repository history, fixes or the network. Linked instructions and dependencies not included here are unavailable: report their evidence limits. Cite file/line, trigger, impact and evidence for each finding; explicitly say when there is no supported finding.\n`,
    );
    for (const file of files) {
      const target = inside(sampleRoot, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.source);
    }
    manifest.samples.push({
      id,
      caseId: entry.id,
      variant,
      revision,
      files: files.map((file) => ({ path: file.path, sha256: digest(file.source) })),
      rubric: entry.rubric,
      evidence: entry.evidence,
      preserve: entry.preserve,
    });
  }
  manifest.samples.sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(
    path.join(destination, 'evaluator.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const results = {
    corpusDigest: corpusDigest(manifest),
    run: {
      model: '',
      instructionRevision: manifest.instructionDigest,
      tools: '',
      budget: '',
      adjudicator: '',
    },
    samples: manifest.samples.map(({ id }) => ({
      id,
      status: 'unavailable',
      response: '',
      durationMs: 0,
      tokens: null,
      findings: [],
    })),
  };
  await writeFile(
    path.join(destination, 'results.template.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  return {
    samples: manifest.samples.length,
    corpusDigest: corpusDigest(manifest),
    output: destination,
  };
}

export async function score(pack, resultsFile) {
  const manifest = manifestSchema.parse(
    JSON.parse(await readBounded(path.join(pack, 'evaluator.json'))),
  );
  const results = resultSchema.parse(JSON.parse(await readBounded(resultsFile)));
  if (results.corpusDigest !== corpusDigest(manifest)) {
    throw new Error('Results belong to a different corpus.');
  }
  const ids = results.samples.map((sample) => sample.id);
  if (
    new Set(ids).size !== ids.length ||
    JSON.stringify(ids.toSorted()) !==
      JSON.stringify(manifest.samples.map((sample) => sample.id).toSorted())
  ) {
    throw new Error('Results must include every sample exactly once.');
  }
  const rows = [];
  for (const expected of manifest.samples) {
    const sample = results.samples.find((item) => item.id === expected.id);
    const sampleRoot = inside(pack, `reviewer/${sample.id}`);
    for (const file of expected.files) {
      if (digest(await readBounded(inside(sampleRoot, file.path))) !== file.sha256) {
        throw new Error(`Source input changed: ${sample.id}/${file.path}`);
      }
    }
    if (
      digest(await readBounded(path.join(sampleRoot, 'instructions.md'))) !==
      manifest.instructionDigest
    ) {
      throw new Error(`Prepared instructions changed: ${sample.id}`);
    }
    if (sample.status === 'unavailable' && sample.findings.length) {
      throw new Error('Unavailable samples cannot have adjudicated findings.');
    }
    if (new Set(sample.findings.map((finding) => finding.id)).size !== sample.findings.length) {
      throw new Error(`Duplicate finding IDs: ${sample.id}`);
    }
    const response = await readBounded(
      inside(path.dirname(path.resolve(resultsFile)), sample.response),
    );
    if (!response.trim()) {
      throw new Error(`Missing raw response or unavailable reason: ${sample.id}`);
    }
    let detected = false;
    for (const finding of sample.findings) {
      if (finding.verdict === 'target-defect' && expected.variant !== 'before') {
        throw new Error('A fixed control cannot contain the known target defect.');
      }
      const source = await readBounded(inside(sampleRoot, finding.file));
      if (finding.line > source.split('\n').length) {
        throw new Error(`Finding line is outside its source: ${sample.id}/${finding.id}`);
      }
      detected ||= finding.verdict === 'target-defect';
    }
    rows.push({
      id: sample.id,
      caseId: expected.caseId,
      variant: expected.variant,
      status: sample.status,
      detected,
      durationMs: sample.durationMs,
      tokens: sample.tokens,
      responseSha256: digest(response),
      findings: sample.findings,
    });
  }
  const complete = rows.every((row) => row.status === 'completed');
  const findings = rows.flatMap((row) => row.findings);
  const count = (verdict) => findings.filter((finding) => finding.verdict === verdict).length;
  return {
    corpusDigest: results.corpusDigest,
    run: results.run,
    complete,
    knownDefects: rows.filter((row) => row.variant === 'before').length,
    detected: rows.filter((row) => row.detected).length,
    unavailable: rows.filter((row) => row.status === 'unavailable').length,
    findings: findings.length,
    falsePositives: count('false-positive'),
    harmful: count('harmful'),
    otherValid: count('other-valid'),
    durationMs: rows.reduce((total, row) => total + row.durationMs, 0),
    tokens: rows.every((row) => row.tokens !== null)
      ? rows.reduce((total, row) => total + row.tokens, 0)
      : null,
    samples: rows,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = new Command().description(
    'Prepare historical review inputs and summarize human-adjudicated responses.',
  );
  cli
    .command('prepare')
    .requiredOption('--out <directory>')
    .action(async ({ out }) => {
      console.log(JSON.stringify(await prepare(repository, out), null, 2));
    });
  cli
    .command('score')
    .requiredOption('--pack <directory>')
    .requiredOption('--results <file>')
    .action(async ({ pack, results }) => {
      const report = await score(path.resolve(pack), path.resolve(results));
      console.log(JSON.stringify(report, null, 2));
      if (!report.complete) {
        process.exitCode = 1;
      }
    });
  cli.parseAsync().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
