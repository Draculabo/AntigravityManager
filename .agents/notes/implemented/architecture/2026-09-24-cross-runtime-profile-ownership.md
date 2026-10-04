# Agent Note: Cross-runtime profile ownership

Status: implemented

## Problem

The Electron main process and standalone Node core use the same account, configuration and database files. Running both against one profile could race writes or credential migration.

## Decision

Both runtimes claim one per-user local endpoint before loading profile configuration, credentials or databases. The endpoint stays bound for the runtime lifetime and answers a bounded, versioned identity probe containing only runtime kind and PID. A second runtime reports the owner and stops before profile initialization. The CLI checks for a desktop owner before spawning, while the core lease remains the final authority for simultaneous starts. Unix sockets live in a private runtime directory and stale socket recovery is serialized by an exclusive guard; Windows uses a per-user named pipe. Failed core shutdown keeps the lease until process exit if the core cannot stop.

## Alternatives considered

- PID files cannot prove that the recorded process still owns this profile, and stale PID reuse can target an unrelated process.
- A lock-file-only scheme cannot distinguish desktop from core for a useful error and needs separate stale-lock arbitration.
- Starting both runtimes and coordinating SQLite writes would leave configuration, keyring migration and gateway side effects unprotected.

## Consequences

The desktop and core are mutually exclusive per user profile. The desktop still embeds its own gateway and does not attach to an existing core. The lease uses built-in Node sockets and the existing Zod dependency; no extra npm locking package is needed. Unix stale recovery needs execution on a Unix CI runner.

## Verification

- Real local IPC tests cover acquisition, conflict, release, owner identity and malformed or oversized replies on Windows.
- Focused startup and launcher tests verify that a conflicting owner prevents profile initialization and child launch.
- Unix stale recovery is covered by a platform-gated test for a Unix CI runner.

