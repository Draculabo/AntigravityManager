import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

export function validateAutomation(root) {
  const errors = [];
  const read = (name) =>
    YAML.parse(readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
  const pr = read('pr-checks.yml');
  const expected = {
    tests: 'testing.yaml',
    lint: 'lint.yaml',
    format: 'format.yaml',
    build: 'build-check.yml',
    react: 'react-doctor.yml',
  };
  if (
    !pr.on?.pull_request ||
    pr.on.pull_request.paths ||
    pr.on.pull_request['paths-ignore'] ||
    pr.on.pull_request_target
  ) {
    errors.push(
      'PR checks must run on every pull request without privileged or path-filtered triggers.',
    );
  }
  for (const [job, file] of Object.entries(expected)) {
    const entry = pr.jobs?.[job];
    if (
      entry?.uses !== `./.github/workflows/${file}` ||
      entry.if !== undefined ||
      entry['continue-on-error'] ||
      entry.secrets
    ) {
      errors.push(
        `PR job ${job} must call its owned workflow unconditionally without inherited secrets.`,
      );
    }
    const child = read(file);
    if (!Object.hasOwn(child.on ?? {}, 'workflow_call') || child.on?.pull_request) {
      errors.push(`${file} must use workflow_call without a duplicate pull_request trigger.`);
    }
  }
  const required = pr.jobs?.required;
  const needs = ['tests', 'lint', 'format', 'build', 'react', 'dependencies'];
  if (
    required?.name !== 'CI required' ||
    required.if !== 'always()' ||
    JSON.stringify(required.needs) !== JSON.stringify(needs) ||
    required['continue-on-error']
  ) {
    errors.push('CI required must always aggregate every owned check without suppressing failure.');
  }
  const review = pr.jobs?.dependencies;
  if (
    !review ||
    review.if !== undefined ||
    review['continue-on-error'] ||
    !review.steps?.some(
      (step) =>
        step.uses?.startsWith('actions/dependency-review-action@') &&
        step.with?.['fail-on-severity'] === 'high' &&
        ![true, 'true'].includes(step.with?.['warn-only']),
    )
  ) {
    errors.push('Dependency review must block high-severity vulnerabilities.');
  }
  const triage = read('issue-triage.yml');
  if (
    triage.on?.pull_request_target ||
    triage.on?.pull_request ||
    !triage.jobs?.analyze?.if?.includes("vars.AI_TRIAGE_ENABLED == 'true'")
  ) {
    errors.push('AI triage requires explicit opt-in and cannot execute PR code.');
  }
  for (const [name, job] of Object.entries(triage.jobs ?? {})) {
    if (
      job.permissions?.contents !== 'read' ||
      job.permissions?.issues !== (name === 'apply' ? 'write' : 'read')
    ) {
      errors.push(`Triage ${name} must separate analysis from issue write permissions.`);
    }
    for (const step of job.steps ?? []) {
      if (
        step.uses?.startsWith('actions/checkout@') &&
        (step.with?.ref !== '${{ github.event.repository.default_branch }}' ||
          step.with?.['persist-credentials'] !== false)
      ) {
        errors.push(
          'Triage must check out trusted default-branch code without persisted credentials.',
        );
      }
      if (name === 'apply' && JSON.stringify(step).includes('secrets.AI_API_KEY')) {
        errors.push('The write-back job cannot receive the model API key.');
      }
    }
  }
  const stale = read('stale-prs.yml');
  const staleAction = stale.jobs?.maintain?.steps?.find((step) =>
    step.uses?.startsWith('actions/stale@'),
  );
  if (
    staleAction?.with?.['days-before-issue-stale'] !== -1 ||
    staleAction?.with?.['days-before-issue-close'] !== -1 ||
    staleAction?.with?.['delete-branch'] !== false
  ) {
    errors.push('PR maintenance must preserve issues and branches.');
  }
  for (const workflow of [pr, triage, stale]) {
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses && !step.uses.startsWith('./') && !/@[a-f0-9]{40}$/.test(step.uses)) {
          errors.push(`Automation actions must be pinned to full commits: ${step.uses}`);
        }
      }
    }
  }
  return errors;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const errors = validateAutomation(process.cwd());
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log('GitHub automation contracts passed.');
    }
  } catch {
    console.error('GitHub automation workflow configuration could not be validated.');
    process.exitCode = 1;
  }
}
