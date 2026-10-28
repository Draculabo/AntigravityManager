import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';
import { ADDITIONAL_CHECKS, CHECKS, CI_LANES } from './checks.mjs';

const PackageSchema = z.object({ scripts: z.record(z.string(), z.string()) });
const CheckSchema = z.object({
  script: z.string().min(1),
  lane: z.enum(['tests', 'lint', 'format', 'build', 'shared']),
  groups: z.array(z.enum(['governance', 'static'])).optional(),
  args: z.array(z.string()).optional(),
  description: z.string().trim().min(1),
});
const WorkflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      'runs-on': z.string(),
      if: z.union([z.string(), z.boolean()]).optional(),
      'continue-on-error': z.boolean().optional(),
      strategy: z.object({ matrix: z.object({ os: z.array(z.string()) }) }).optional(),
      steps: z.array(
        z.object({
          run: z.string().optional(),
          uses: z.string().optional(),
          with: z.object({ 'node-version-file': z.string().optional() }).optional(),
          if: z.union([z.string(), z.boolean()]).optional(),
          'continue-on-error': z.boolean().optional(),
        }),
      ),
    }),
  ),
});

function readText(root, file) {
  return readFileSync(path.join(root, file), 'utf8');
}

/** Check the actual pnpm and Actions entry points, rather than a second list of expected tests. */
export function validateQualityContracts(root) {
  const errors = [];
  const scripts = PackageSchema.parse(JSON.parse(readText(root, 'package.json'))).scripts;
  const checks = z.array(CheckSchema).parse(CHECKS);
  const seen = new Set();
  for (const check of checks) {
    if (seen.has(check.script)) {
      errors.push(`Duplicate registered check: ${check.script}`);
    }
    seen.add(check.script);
    if (!scripts[check.script]) {
      errors.push(`Registered check references missing pnpm script: ${check.script}`);
    }
    if (
      check.script === 'check:ci' ||
      check.script === 'check:governance' ||
      check.script === 'check:static'
    ) {
      errors.push(`Aggregate cannot register itself as a leaf: ${check.script}`);
    }
  }
  const additional = z.record(z.string(), z.string().trim().min(1)).parse(ADDITIONAL_CHECKS);
  for (const script of Object.keys(additional)) {
    if (seen.has(script)) {
      errors.push(`Verification command is both a CI leaf and an additional entry: ${script}`);
    }
    if (!scripts[script]) {
      errors.push(`Additional entry references missing pnpm script: ${script}`);
    }
  }
  const aggregates = ['check:ci', 'check:governance', 'check:static'];
  for (const script of Object.keys(scripts)) {
    if (
      /^(?:check:|test(?::|$)|verify:)/.test(script) &&
      !seen.has(script) &&
      !Object.hasOwn(additional, script) &&
      !aggregates.includes(script)
    ) {
      errors.push(
        `Unclassified verification command: ${script}. Register a CI check or explain its additional entry point.`,
      );
    }
  }
  for (const [name, suffix] of [
    ['check:ci', ''],
    ['check:governance', ' governance'],
    ['check:static', ' static'],
  ]) {
    if (scripts[name] !== `node scripts/quality/run.mjs${suffix}`) {
      errors.push(`${name} must use the shared quality runner.`);
    }
  }
  if (scripts['check:quality'] !== 'node scripts/quality/contracts.mjs') {
    errors.push('check:quality must execute the quality contract validator.');
  }
  if (!readText(root, 'scripts/README.md').includes('pnpm run check:ci --list')) {
    errors.push('scripts/README.md must link to the executable check inventory.');
  }
  for (const [name, lane] of Object.entries(CI_LANES)) {
    if (!checks.some((check) => check.lane === name)) {
      errors.push(`CI lane has no registered checks: ${name}`);
    }
    const workflow = WorkflowSchema.parse(YAML.parse(readText(root, lane.workflow)));
    const job = workflow.jobs[lane.job];
    if (!job) {
      errors.push(`${lane.workflow}: missing required job ${lane.job}.`);
      continue;
    }
    const setup = job.steps.findIndex((step) => step.uses?.startsWith('pnpm/action-setup@'));
    const node = job.steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
    const install = job.steps.findIndex(
      (step) => step.run?.trim() === 'pnpm install --frozen-lockfile',
    );
    if (
      setup < 0 ||
      node <= setup ||
      install <= node ||
      job.steps[node].with?.['node-version-file'] !== '.nvmrc'
    ) {
      errors.push(`${lane.workflow}: use pinned pnpm and Node before a frozen dependency install.`);
    }
    const expected = `pnpm run check:ci ${name}`;
    const steps = job.steps.filter((step) => step.run?.trim() === expected);
    if (steps.length !== 1) {
      errors.push(`${lane.workflow}: ${lane.job} must execute exactly once: ${expected}`);
    }
    if (
      job.if !== undefined ||
      job['continue-on-error'] ||
      steps.some((step) => step.if !== undefined || step['continue-on-error'])
    ) {
      errors.push(`${lane.workflow}: required checks must run unconditionally and block failures.`);
    }
    const platforms =
      job['runs-on'] === '${{ matrix.os }}' ? job.strategy?.matrix.os : [job['runs-on']];
    if (JSON.stringify(platforms?.toSorted()) !== JSON.stringify(lane.platforms.toSorted())) {
      errors.push(`${lane.workflow}: ${lane.job} must cover ${lane.platforms.join(', ')}.`);
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const errors = validateQualityContracts(process.argv[2] ?? process.cwd());
    if (errors.length) {
      console.error(`Quality contracts failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log('Quality contracts passed.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
