# Agent Note: Node service CLI

Status: implemented

## Problem

The standalone core needs a way to start, inspect and stop it without loading Electron. A shell script per platform would duplicate lifecycle behavior and make status/error handling inconsistent.

## Decision

The Node/TypeScript CLI uses Commander for command parsing and a typed management client over the existing local HTTP socket or pipe. It launches the built core with the current Node executable, passes no secrets on the command line, and inherits only a limited set of environment variables needed to find the user profile and local keyring. Start and stop are bounded and idempotent; start probes the shared profile owner before spawning, waits for the core to report `running`, and stop waits for the endpoint to disappear.

## Alternatives considered

- Handwritten argument parsing would add avoidable help and error handling code.
- PID files and direct process termination could target an unrelated process after PID reuse.
- Immediately exposing account commands would expand the management protocol before the process boundary is proven.

## Consequences

The CLI and core have separate Electron-free builds. The resolver currently expects sibling `dist/cli` and `dist/core` artifacts. Packaged sibling executable resolution and the full account/OAuth command surface remain separate work. Unix-specific stale-socket recovery still needs execution on a Unix CI runner.

## Verification

- Focused client, launcher and CLI tests cover transport validation, deadlines, concurrency and exit codes.
- The built CLI responds to `--help`; type-check and the Electron import guard pass.
