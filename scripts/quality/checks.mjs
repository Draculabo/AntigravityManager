export const CI_LANES = {
  build: {
    workflow: '.github/workflows/build-check.yml',
    job: 'build',
    platforms: ['ubuntu-latest', 'windows-latest'],
  },
  tests: {
    workflow: '.github/workflows/testing.yaml',
    job: 'tests-unit',
    platforms: ['ubuntu-latest', 'windows-latest'],
  },
  lint: { workflow: '.github/workflows/lint.yaml', job: 'check', platforms: ['ubuntu-latest'] },
  format: {
    workflow: '.github/workflows/format.yaml',
    job: 'tests-unit',
    platforms: ['ubuntu-latest'],
  },
};

// Shared checks run in each CI lane so another lane can detect missing workflow wiring.
export const CHECKS = [
  {
    script: 'check:automation',
    lane: 'tests',
    groups: ['governance'],
    description: 'Verify trusted triage, PR maintenance and complete merge-gate wiring.',
  },
  {
    script: 'test:automation',
    lane: 'tests',
    groups: ['governance'],
    description:
      'Exercise issue boundaries, SDK requests, retries and automation workflow regressions without network calls.',
  },
  { script: 'build:core', lane: 'build', description: 'Compile the standalone core and workers.' },
  { script: 'build:cli', lane: 'build', description: 'Compile the standalone CLI.' },
  {
    script: 'package',
    lane: 'build',
    description: 'Build the unsigned Electron app without publishing or running installers.',
  },
  {
    script: 'check:agent-contracts',
    lane: 'tests',
    groups: ['governance'],
    description:
      'Validate agent instructions, skill entries and mirrors, decision records and local references.',
  },
  {
    script: 'check:quality',
    lane: 'shared',
    groups: ['governance'],
    description: 'Verify check registration, pnpm entry points and CI lane coverage.',
  },
  {
    script: 'test:quality',
    lane: 'tests',
    groups: ['governance'],
    description: 'Exercise check selection, failed execution and deliberately invalid CI fixtures.',
  },
  {
    script: 'test:change-scope',
    lane: 'tests',
    groups: ['governance'],
    description: 'Test Git revision and worktree change reporting in isolated repositories.',
  },
  {
    script: 'test:import-graph',
    lane: 'tests',
    groups: ['governance'],
    description: 'Test import discovery and runtime dependency classification.',
  },
  {
    script: 'test:runtime-boundaries',
    lane: 'tests',
    groups: ['governance'],
    description: 'Test forbidden runtime imports and their permitted alternatives.',
  },
  {
    script: 'test:type-boundaries',
    lane: 'tests',
    groups: ['governance'],
    description: 'Test unsafe type baseline enforcement and controlled exceptions.',
  },
  {
    script: 'verify:boundaries:enforce',
    lane: 'tests',
    groups: ['governance'],
    description: 'Reject runtime dependency violations in the current worktree.',
  },
  {
    script: 'verify:type-boundaries',
    lane: 'tests',
    groups: ['governance'],
    description: 'Reject new unsafe production type patterns against the reviewed baseline.',
  },
  {
    script: 'test:git-hooks',
    lane: 'tests',
    description:
      'Exercise installed hooks and index-only lint with isolated commits and local pushes.',
  },
  {
    script: 'type-check',
    lane: 'tests',
    groups: ['static'],
    description: 'Check TypeScript without emitting build output.',
  },
  {
    script: 'lint',
    lane: 'lint',
    groups: ['static'],
    description: 'Check repository code with ESLint without applying fixes.',
  },
  {
    script: 'format',
    lane: 'format',
    groups: ['static'],
    description: 'Check repository formatting without rewriting files.',
  },
  {
    script: 'test:unit',
    args: ['--run'],
    lane: 'tests',
    description: 'Run application unit tests once, without watch mode.',
  },
  {
    script: 'test:acceptance',
    args: ['unit'],
    lane: 'tests',
    description:
      'Test acceptance harnesses with synthetic data, without live or installer actions.',
  },
];

export const SELECTIONS = ['all', 'governance', 'static', ...Object.keys(CI_LANES)];

// These entry points require a deliberate selection or are covered by another registered check.
export const ADDITIONAL_CHECKS = {
  test: 'One-shot unit alias; CI uses test:unit with its explicit run argument.',
  'test:agent-contracts': 'Harness tests already invoked by check:agent-contracts.',
  'test:review-eval':
    'Manual historical review harness/probes require local case revisions; not an automatic model evaluation.',
  'test:watch': 'Interactive watch mode; use one-shot unit checks in CI.',
  'verify:boundaries': 'Advisory dependency report; CI uses the enforcing variant.',
  'verify:root-ipc-boundary': 'Focused root IPC check covered by the complete boundary gate.',
  'test:appimage-download': 'Focused Linux installer harness; select for AppImage changes.',
  'test:appimage-update': 'Native AppImage update acceptance requires a prepared Linux artifact.',
  'test:schema:replay': 'Read-only replay requires selected local audit inputs.',
  'test:schema:selection': 'Focused replay-selection harness; select for schema replay changes.',
  'test:schema:live': 'Live provider acceptance requires prepared accounts and consumes quota.',
  'test:schema:client':
    'Real coding-client acceptance requires prepared clients and provider access.',
  'test:schema:sentry': 'Remote diagnostic receipt acceptance requires private read-only access.',
  'test:diagnostics:sentry': 'Diagnostic acceptance has separate local and authorized live modes.',
  'test:diagnostics:packaged':
    'Packaged diagnostics require an application artifact and isolated state.',
  'test:e2e': 'Electron user-flow acceptance requires the owning graphical environment.',
  'test:performance':
    'Selected Electron profiling scenarios require an isolated graphical environment.',
  'test:performance-recorder-process':
    'Native Windows command-shell regression; select for recorder changes.',
  'test:workspace': 'Workspace profile multi-instance isolation and persistence unit test suite.',
  'test:all': 'Full unit, harness and Electron rehearsal; select explicitly for its broad scope.',
};

/** Resolve a named selection once; CI lanes and local groups share check order and arguments. */
export function selectChecks(selection) {
  if (!SELECTIONS.includes(selection)) {
    throw new Error(`Unknown check selection: ${selection}. Choose ${SELECTIONS.join(', ')}.`);
  }
  return CHECKS.filter(
    (check) =>
      selection === 'all' ||
      check.lane === selection ||
      (Object.hasOwn(CI_LANES, selection) && check.lane === 'shared') ||
      check.groups?.includes(selection),
  ).map((check) => ({ ...check, args: check.args ?? [] }));
}
