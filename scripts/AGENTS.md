# Script and Acceptance Instructions

These instructions supplement the root [AGENTS.md](../AGENTS.md). Scripts provide agent-facing verification, artifact preparation and release tooling; application behavior remains in its owning production module.

## Choose and run existing evidence

1. Start with [the script guide](README.md), the owning `package.json` command and [testing strategy](../docs/testing.md). Use the existing runner when it exercises the changed behavior; inspect its implementation and SOP when arguments, setup or side effects are unclear.
2. Identify the input artifact or runtime, platform/ABI, account/provider requirements, writable paths, shared OS state and cleanup owner. Top-level `pnpm run test:acceptance --help` only lists checks; forwarding `--help` to a leaf is not a general side-effect guarantee.
3. Select the smallest check that covers the regression. A prepared fixture, compilation or report aggregation does not itself establish a passed acceptance result.
4. For native, live-account or installer checks, follow the linked SOP within the user's authorized scope. Verify backups and cleanup targets before mutation, and keep shared resources exclusive where isolation is unavailable. Accepting official terms and publishing still require their applicable authorization.
5. Record the actual command, revision/artifact, selected scenario, observed assertions, exit status, cleanup result and evidence limits. Treat a timeout, missing required result or failed restoration as failure; keep skipped, partial and unavailable evidence distinct from passing.

## Change a runner

- Reuse production entry points and existing owned helpers. Add a script only when no existing runner covers the behavior; explain that gap and place it in the directory that owns the scenario.
- Follow [test reliability](../docs/test-reliability.md) for shared resources, global mutation, readiness, deadlines and complete teardown. Follow [failure ownership](../docs/error-handling.md) for partial effects, retries and recovery.
- Preserve behavior detection: a changed acceptance predicate needs a representative failing fixture through the real runner. Keep pure harness tests separate from native or live acceptance.
- Document a new public runner in [README.md](README.md) or its owning SOP, including prerequisites, effects, cleanup and what its result establishes. Use the unified acceptance dispatcher for a new check that fits an existing suite; keep build/release tools under their own commands.
- Bound subprocess output and sanitize reports. Keep real credentials, account identities, private logs and profiles out of committed fixtures and exported evidence.

Run the owning harness tests after script changes. Governance changes also require `pnpm run check:agent-contracts` and focused formatting. [Testing strategy](../docs/testing.md) owns decisions about broader evidence.
