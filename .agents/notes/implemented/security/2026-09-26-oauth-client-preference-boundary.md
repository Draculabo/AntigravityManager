# Agent Note: OAuth Client Preference Boundary

Status: implemented

## Problem

The desktop IPC handler owned OAuth client discovery and active-client preference while the standalone core needed the same state for later headless authentication. The previous renderer schema allowed future descriptor fields to cross automatically, and malformed registry configuration logs could include client secrets.

## Decision

The cloud-account OAuth settings service owns listing, reading and setting the active client alongside its existing hydration and legacy backfill logic. The account adapter exposes those three operations in embedded and remote modes. Core RPC and renderer ORPC use strict feature-owned schemas and expose only the public key, label, client ID and active/builtin flags. The existing registry validates selections; successful changes persist through `active_oauth_client_key`. Unknown selections and invalid stored values produce value-free errors and logs. Invalid registry environment entries are logged without the raw entry. Electron still selects embedded mode, and desktop authorization-code authentication remains there.

## Alternatives considered

- Copying registry and settings logic into core RPC would create divergent active-client state.
- Forwarding registry configuration objects would expose client secrets and future internal fields.
- Routing desktop authorization codes into the standalone core would expand the authentication trust boundary before its session contract is ready.

## Consequences

Remote selection changes the standalone core's active client and persisted preference without calling embedded storage. The desktop authentication path continues to use the shared service but does not become remote. A later ownership switch must use the core-owned headless OAuth session for authentication and validate cross-process startup behavior.

## Verification

- Service tests cover persisted selection, strict descriptors, unknown keys and value-free invalid-setting logs.
- Real private pipe/socket tests cover embedded/remote preference parity, state visibility after a remote set, bounded key rejection and no fallback.
- Registry tests cover malformed environment entries without secret-bearing logs; type checking, runtime boundaries and the core build cover the Node dependency path.
