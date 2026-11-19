# Upgrade guide: Preserve independent client connection profiles

Target version: next

## Affected users

Users who create independent connection profiles use a new version-1 catalog under the selected
owner's profile directory. Existing individual Claude/Codex/OpenCode configuration is not migrated
automatically. Users who do not create profiles can upgrade normally. Desktop and standalone Core
must be upgraded together to owner compatibility 17.

## Required action

1. Stop Manager and its standalone Core before copying or restoring profile data. Keep the native
   clients' original configuration and their existing private backups.
2. Preserve the selected owner's OS-user keyring together with the profile directory. The catalog
   alone cannot restore per-profile keys or decrypt recovery content. Use OS-supported keyring
   backup/migration; do not export secrets into an ordinary diagnostic archive.
3. After upgrading both owners, review the saved profile and create a fresh preview before apply
   or remove. Client settings change only when that reviewed operation is confirmed.
4. Reopen the client and verify a request in Traffic Monitor. A saved profile or ownership receipt
   does not prove that the client read the settings or that the provider accepted the key.

## Data and recovery

The bounded catalog stores non-secret connection metadata and encrypted receipts, first backups
and a pending write journal. Credential snapshots and the random recovery encryption key remain
in the owning user's native keyring. Native client files retain credentials required by their
own format; DSH uses its supported native reference store. No account database migration occurs.

For an interrupted multi-file write, the owner resumes the remaining authorized edit only if the
first file matches its recorded result and the second file matches its recorded source. An
interrupted write reconciles only exact recorded before/after native bytes. Changed bytes,
missing keys or a damaged encrypted envelope cause refusal. Do not delete keyring entries or
reset the catalog as an automatic repair. Preserve both stores and the client files for inspection.
A profile or credential write may partially complete; a failed response does not mean rollback
succeeded. Keep the first backups until actual client use and intended recovery are checked.

If the original keyring cannot be recovered, encrypted ownership/backups cannot be decrypted.
Existing client settings may still work, but Manager cannot claim their lost ownership. Stop the
owner, preserve the catalog and client files, and restore a verified backup using the corresponding
client's recovery process. Recreate a profile only after inspecting the remaining native settings;
do not remove unrelated provider nodes. This is a proposed recovery procedure, not executed evidence.

## Downgrade

Older owners cannot manage the new profile library. Do not pair an older Core with this desktop.
An owner that predates a client rejects a catalog containing that client's profile. This applies
to Kimi Code, Qwen Code, Gemini CLI and Pi. Finish any pending native write, review and remove the
native connection, then delete the affected saved profile
before returning to an owner that supports the catalog but predates this client.
Keep the catalog and original keyring intact when downgrading. Native client changes remain until
explicitly removed or restored; an application downgrade does not undo them. Automatic recovery or
cross-machine portability without the original keyring is unsupported.

## Verification

The native profile tests cover preview, apply, default selection, removal, stale previews and
multi-file recovery when the native contents still match the recorded intent.
The Windows live check exercises Kimi Code 2.7.0 against an isolated Core and checks configuration
restoration after a real tool call. Native keyring migration, cross-machine recovery and downgrade
remain outside these checks. Follow the current [client configuration reference](../../modules/proxy-gateway/agent-tools.md)
and [ownership decision](../../../.agents/notes/implemented/feature/2026-10-04-coding-tool-configuration.md)
when preparing the original D21 acceptance evidence.
