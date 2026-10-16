# Diagnostic Acceptance

This procedure spans account operations, the SDK and desktop presentation. Read [diagnostic privacy](../security/diagnostics.md) and the [script instructions](../../scripts/AGENTS.md) before native or remote checks.

Run commands from the repository root unless a step specifies another directory.

## Account-operation diagnostic acceptance

The focused `correlated-operation-diagnostics` and `google-login-diagnostics` suites exercise
classification, bounded/cyclic causes, SDK receipts, scope isolation, forwarding suppression and
safe projections. Login failures pass through enrollment, the callback listener, public IPC,
details and report text. Remote HTTP rejection uses a real loopback HTTP proxy with Axios'
Node adapter and the private management endpoint; provider credentials and persistence are
synthetic or blocked. The adjacent OAuth, switch-owner, management/RPC, CLI, error-toast and
attachment suites cover their existing side effects and error contracts.

`pnpm run test:diagnostics:sentry` runs the actual Node and Electron SDK adapters against a
bounded local receiver with isolated opted-in preferences. `--offline` returns HTTP 503 while
checking local receipt semantics. `--packaged` additionally builds and runs an isolated Electron
ASAR diagnostic executable, with profile path resolution redirected before loading the SDK.
This harness contains no account/credential owner and does not verify a full product installer,
native keyring or live Google authorization.

The service-launcher suite accepts a healthy core becoming ready after 60 seconds, verifies the
90-second default deadline for an unavailable child, and checks that waiting does not launch
another child. Packaged acceptance keeps CDP and window discovery bounded and attempts desktop
closure and core shutdown independently during recovery.

On Windows, `pnpm run test:diagnostics:packaged <desktop-executable>` exercises the full
packaged or installed product with empty isolated profiles and reporting disabled. Both
desktop owner modes must retain login and switch diagnostics through the production preload
and public IPC; the real login toast must expose its reference in Error details. The packaged
CLI exchanges a synthetic authorization code through a local proxy returning HTTP 503 and
must use HTTPS CONNECT and retain the upstream status/code and closed HTTP evidence in its
terminal diagnostic and local log. The focused logging regression checks the actual Winston
transport output: shared cause evidence and safe readback booleans must survive strict parsing,
while generic payloads still mask secrets and actual cycles. No real Google
authorization or official-client credential write is attempted. The check requires an existing
application master key, compares both master-key slots without printing their contents, restores
Windows login settings and removes only its isolated profiles.

For installation evidence on a clean authorized Windows host, append `--operation-diagnostics`
to `pnpm run test:acceptance installers msi <current-msi>`. The installer guard refuses to
replace an existing product in the same upgrade family. Running the diagnostics against the
packaged executable validates its payload, not MSI installation or upgrade behavior.

The standalone native runtime gate retains its throwing Electron substitute and presentation-side
SQLite, worker and keyring guards. It uses the Electron-free app-shell connection for management
and verified shutdown; the full Electron gate separately covers the desktop connection facade.
An empty plaintext account profile must not create a master key. The security probe then explicitly
initializes encryption, verifies the uniquely scoped native key, and decrypts its synthetic payload
in a second process. Native credential cleanup covers both the CRUD probe and that generated key.

`--live` forwards only validated non-secret event items to the configured Sentry DSN. A successful
SDK receipt, flush or HTTP response is insufficient to prove storage: read the stored event
using the private read-only token and compare UUID, `operation_runtime`, stage, reason, release
and the privacy projection. The token remains outside the application. These controls do not
establish that a synthetic failure caused an existing user's incident.

Google HTTP failure diagnostics have real loopback origin and proxy controls in
`google-http-evidence.test.ts` and `google-login-diagnostics.test.ts`. They verify proxy CONNECT authentication, 502 HTML
and 503 OAuth JSON across refresh, private management, public IPC, details and reporting.
`correlated-operation-diagnostics.test.ts` verifies the same closed fields in Sentry projection,
sanitation and the public byte budget. These controls do not identify the source of an earlier 502.
The proxy transport tests also require cancellation to close a stalled CONNECT socket and
preserve NO_PROXY behavior. The local acceptance unit suite also checks read-only Classic terms-file classification.
