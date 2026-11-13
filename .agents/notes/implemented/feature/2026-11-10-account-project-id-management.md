# Agent Note: Account Project ID management

Status: implemented

## Problem

Automatic Google project discovery can leave a saved ID that users need to inspect or correct.
Adding a control introduces a second writer alongside gateway discovery and OAuth refresh.
A delayed provider response must not undo a user's correction or clear.

## Decision

The account owner exposes strict Project ID read, edit, clear, and discovery operations through
desktop IPC and standalone Core RPC. The renderer receives the ID alone. Explicit discovery uses
the selected account's credential and egress context. A successful update patches only `project_id`
in the existing token JSON. A clear removes the field so future gateway requests can discover it.

The write transaction compares the expected ID against the stored value. Discovery also checks the
account lifecycle, OAuth grant, access token, egress and the revision held while discovery is in
flight. Explicit edits and clears invalidate older discovery even when the resulting ID matches its
starting value. Gateway cache replacement invalidates the previous probe and its writeback for that
account. Credential refresh writes compare their token baseline before replacing the stored token.

## Alternatives considered

- Sending full account tokens to the editor would expose credentials unnecessarily.
- Making the ID select a provider route would conflate account metadata with gateway policy.
- Reloading every gateway account after an edit would replace unrelated in-memory routing state.

## Consequences

Desktop and standalone Core use owner compatibility `12` and upgrade together. The existing
database schema remains readable by earlier builds. Provider discovery failure preserves the saved
ID. If a credential refresh succeeds before a later discovery failure, the refreshed credential is
retained. Users can restore a previous ID with the same account editor.

## Verification

- The Project ID dialog tests cover save, clear, lookup failure and conflict recovery.
- The account Project ID service tests exercise SQLite field updates and delayed provider and OAuth
  responses. The lease writeback test covers an automatic probe returning after an explicit edit.
- The Core RPC round-trip checks all three Project ID operations through the private endpoint.
