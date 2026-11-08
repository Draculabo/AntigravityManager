# Upgrade guide: Keep originals for Responses tool-media continuation

Target version: next

## Affected users

Users retaining Responses histories with valid standalone, JSON-field or Markdown images
inside tool-result text now write version-2 private text references. Existing version-1
image/audio references continue to work. Ordinary text, invalid image candidates, tool
arguments, metadata and public Files handles retain their existing behavior.

## Required action

1. Upgrade normally; no database migration or credential update is required.
2. Keep original client history or the original images when continuation must survive
   the private store's capacity or 48-hour retention limit.
3. If continuation returns 410, start a new conversation and resend the originals.
   Retrying an expired private reference cannot reconstruct lost content.

## Data and recovery

Private storage preserves exact tool text, including JSON/Markdown whitespace, in
16 MiB chunks with a 64 MiB serialized-text ceiling. Chunks share the existing 512 MiB
private namespace budget. References are committed only after their private writes;
partial writes do not publish a usable session and expire under the same bounded policy.
Each restored text is checked against its total byte count and SHA-256. A window omission
does not delete the private original; disabling the window can restore it while retained.
No account data, database schema or public file namespace is modified.

## Downgrade

Older versions cannot read newly written version-2 tool-text references. After downgrade,
start a new conversation and resend the client-held original history or images rather
than reusing those response IDs. This change does not provide an in-place downgrade
converter. Existing version-1 media references keep their prior format; previously lost
media cannot be reconstructed. Cross-version installed-client downgrade remains unverified.

## Verification

Controlled store and disk-owner close/reopen tests cover exact original text, private
references, missing/altered content, owner isolation and original image parts in a mapped
generation request. See the [current media reference](../../modules/proxy-gateway/inline-media-and-thought-history.md)
and [decision record](../../../.agents/notes/implemented/bug-fix/2026-10-10-inline-media-thought-capture.md).
These checks use synthetic files and substituted upstreams. They do not establish live
provider image understanding, installer behavior or a real cross-version downgrade.
