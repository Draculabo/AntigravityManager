# Upgrade guide: Upgrade desktop and standalone Core together

Target version: next

## Affected users

This applies to profiles using a standalone Core owner. Desktop-only profiles can upgrade normally.

## Required action

1. Stop the standalone Core with the currently installed `service stop` command, then close Manager.
2. Install Manager and standalone Core from the same release.
3. Start Core and open Manager. Open **Project ID** on a Google account card to check that the
   saved value can be read through the selected owner. Open the local account import preview to
   check that it loads with the Antigravity CLI source.
4. Open **API Proxy > Model Mapping** to read alias publication and routing settings. Both
   processes support the optional publication field.
5. Use the manual Google sign-in field with an active login session. Desktop and Core require
   owner compatibility `15` to accept complete callback input through that field.
6. The grouped minute-trend response requires owner compatibility `18`. It reads existing
   audit records with their original model IDs.
7. Open an account's **Network proxy** dialog to review its optional Gemini and Claude priorities.
   Desktop and Core require owner compatibility `19` for the family overrides.
8. Open **Traffic Monitor > Overview** and select an actual model to inspect its requests.
   The overview and its attempt filters require owner compatibility `20`.
9. Open **Traffic Monitor > Requests** and search for a session title in the session filter.
   The session lookup requires owner compatibility `21`.
10. Open **Traffic Monitor > Requests** and verify that the daily heatmap updates with the request
    filters. The filtered 53-week activity query requires owner compatibility `23`.
11. Open **Add Account > Token / JSON**. Pasted account import requires owner compatibility `24`.

## Data and recovery

Startup adds two nullable account priority columns. Existing accounts inherit their global priority.
Stop both processes before restoring a profile backup so neither owner can publish a stale account.
The new overview and its drill-down reuse the existing audit database format.

Project ID uses the existing account field, and the CLI import source reads the existing sign-in
file. Both use the current data format. Manager rejects an incompatible owner before account
mutations. If Manager cannot connect after an upgrade, verify that both installations are from
the same release. Keep the account profile in place. Existing exact aliases retain publication
when the field is absent. The enabled legacy mapping projection continues to support older
static routes; automatic targets are new and require this release.
Manual OAuth input is volatile and does not change account storage. Invalid pasted data leaves
the pending session available for a corrected submission. If the session expired, start login
again rather than replay an old callback.

## Downgrade

Older builds use the global priority. Preserve a profile backup to retain the override values when
moving between releases.

Stop both processes and restore a matching desktop and Core pair. Before returning to a build
without automatic routing, replace each `auto:*` target with
a supported physical model. Older builds may ignore alias visibility and publish hidden aliases;
retain a copy of the service configuration before downgrading. A mixed-version desktop/Core pair
is unsupported. Check any other upgrade guides for the releases involved.
Older releases accept only a raw authorization code in the manual field; complete callback
addresses and encoded input need this release.

## Verification

The [private Core RPC integration test](../../../src/tests/unit/core-rpc.test.ts) exercises the
Project ID operations and local account import preview over a local endpoint. The
[handshake integration test](../../../src/tests/unit/core-management-ipc.test.ts) covers the owner
compatibility contract. A live Google account and installed-client acceptance remain separate.

The [alias HTTP checks](../../../src/tests/unit/d22-alias-publication-http.test.ts) cover shared
directory/probe visibility. [Configuration migration checks](../../../src/tests/unit/config-manager-alias-migration.test.ts)
cover preservation of existing rules. Downgrade to an older executable is not exercised.

See [cloud account settings](../../modules/cloud-account/overview.md) for the editor and CLI import behavior.
