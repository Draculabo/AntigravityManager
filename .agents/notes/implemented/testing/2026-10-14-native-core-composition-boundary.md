# Agent Note: Native core composition boundary

Status: implemented

## Problem

The Node presentation harness imported `desktopCoreConnection`, which also imports Electron
and desktop preferences. Its throwing Electron substitute correctly rejected that graph before
the core lifecycle assertions ran. The later master-key assertion also assumed that an empty
account profile always initializes encryption; plaintext account persistence initializes a key
only when encryption or encrypted-data recovery requires it.

## Decision

The app-shell `standaloneCoreConnection` owns the shared management endpoint, profile identity,
owner probe and verified terminal drain. The desktop facade supplies Electron launch context,
persisted reporting consent and feature selection. The native harness supplies its isolated
launcher and remote composition with reporting disabled. No Electron substitute or native-state
guard is removed.

The native runtime gate first verifies that the empty plaintext profile did not create a key.
A separate production-security probe initializes encryption under the unique synthetic keyring
service, verifies persistence, and decrypts its saved synthetic payload in another process. Core
RSS observations remain attached only to actual core processes.

## Alternatives considered

- Permit Electron `app` methods in the Node substitute: weakens the runtime-boundary evidence.
- Duplicate management/drain code in the harness: lets verification diverge from production.
- Generate a key on every empty startup: changes security behavior to satisfy an obsolete test.
- Remove the key assertion: loses native provider persistence and recovery coverage.

## Consequences

The split introduces one app-shell-owned connection module with a desktop and native-composition
consumer. It does not introduce a new transport, schema, credential location or persistence format.
The Electron lifecycle gate remains necessary for launch context, consent and actual windows;
Node evidence does not establish those desktop behaviors.

## Verification

On Windows x64, the previously failing installed native gate passes against the complete 0.25.1
standalone payload using Node 24.19.0. It covers SQLite WAL/reopen, real uniquely scoped credential
CRUD, remote account/configuration views, gateway authentication, audit persistence, external
attachment, verified closure, core crash recovery and stale-epoch rejection. Security write,
persistence and separate-process decryption pass; synthetic credentials are cleaned up.

The three owner/service/profile startup suites pass 14 tests. Type checking and runtime dependency
boundaries pass. The current full Electron payload and WSL follow-up runs are recorded in the
[correlated diagnostics note](../security/2026-10-14-correlated-operation-diagnostics.md).
