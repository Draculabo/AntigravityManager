# Agent Note: Keep generated test output outside source linting

Status: implemented

## Problem

`npm run lint` imports only `.prettierignore`, while Git and Prettier already exclude saved
Playwright output through `.gitignore`. A local static check traverses minified Electron bundles
under `test-results/issue-325` and exhausts Node's default heap before completing source linting.

## Decision

ESLint imports the existing `.gitignore` alongside `.prettierignore` using the installed
`@eslint/compat` helper. The repository's existing generated-output ownership determines the
ignored paths; no source lint rules or assertions are weakened.

## Alternatives considered

- Increasing the heap leaves generated bundles in scope and makes local checks depend on memory.
- Passing temporary ignore flags does not fix the owning npm script or CI behavior.
- Duplicating generated-directory patterns creates a second list that can drift from Git ignores.

## Consequences

Generated reports, fixture bundles and build output are excluded consistently. Production code
and test sources retain the existing lint rules. Changes to `.gitignore` also affect source
linting and require review for unintended source exclusions.

## Verification

Use ESLint's `isPathIgnored` API to verify that the previously traversed renderer bundle is
ignored and that configuration production code and its regression tests remain in scope.
Run `npm run check:static` and `npm run check:agent-contracts` after the change. These checks
do not establish packaged application or live-provider behavior.
