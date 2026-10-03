# Cloud Account Management and Intelligent Switching

This document explains the cloud AI account management and switching capabilities in Antigravity Manager. The feature allows users to manage multiple Google accounts, monitor API quotas, and seamlessly switch the active IDE account with one click.

## 1. Core Features

### 1.1 Account Pool Management

- **Add accounts**: Add accounts via Google OAuth authorization code.
- **List view**: Display all added accounts, including avatar, email, and last used time.
- **Status monitoring**: Show real-time account status (Active, Rate Limited, Expired) and whether the account is currently active.
- **Delete accounts**: Remove accounts from the local database.

### 1.2 Real-Time Quota Monitoring

- **Multi-model support**: Track quota usage for models such as `gemini-pro`, `claude-3-5-sonnet`, and more.
- **Grouped quota support**: Track shared quota buckets returned by `retrieveUserQuotaSummary`, including Claude/GPT third-party quota groups.
- **Visual indicators**: Use progress bars and color states (green/yellow/red) to show remaining quota percentage.
- **Auto/manual refresh**: Support manual quota refresh; the system also checks quota automatically before switching.

### 1.4 Intelligent Auto-Switching

- **Unlimited pool mode**: When the current account quota is low (`<5%`) or rate-limited, the system automatically finds and switches to the best backup account.
- **Background monitoring**: Built-in `CloudMonitorService` polls quota status for all accounts every 5 minutes by default.
- **Global toggle**: Users can enable or disable this feature with one click in the UI.

### 1.5 Weekly Quota and Opt-In Warmu

The account toolbar selects the five-hour or weekly quota view. The weekly view uses provider buckets whose `window` or `bucket_id` contains `week`, case-insensitively. It never substitutes model quota when weekly buckets are missing. The five-hour view retains non-weekly detailed buckets. The preference is local to the renderer; unavailable browser storage falls back to the five-hour view.

Settings > Models provides an independent weekly warmup switch and Claude/Gemini group selection. Warmup is off by default. Enabling it keeps the existing five-minute monitor running even when auto-switch is off. Only successful fresh quota/token refreshes, including manual refreshes, supply candidates. While warmup is enabled, the visible account list rereads local snapshots every minute; this renderer refresh does not call the provider.

Eligibility requires a Google account without a non-active status or forbidden quota flag, at least `0.999` remaining fraction, and a valid reset timestamp that has passed less than six days ago. The selected group must be enabled. Each weekly bucket uses `claude-sonnet-4-6` or `gemini-3-flash` as its representative. Missing weekly groups and unavailable project context are not replaced with guessed values.

Warmup consumes real model quota and may use AI credits. HTTP acceptance is recorded as success; it does not prove that the provider restarted a weekly timer or completed generation. The application rereads quota after successful warmups. No live-provider timer or cost guarantee is implied.

### 1.6 Warmup Execution and Recovery

`WeeklyWarmupService` owns a serial main-process queue shared by scheduled and manual refreshes. There is a two-second delay between candidates. Configuration changes and monitor shutdown cancel the active generation request and prevent queued candidates from starting. An already accepted provider request cannot be undone.

The cloud-account module persists validated configuration and versioned history in existing settings rows, without a schema migration. History keys contain account ID, bucket ID, the weekly window, and a normalized reset timestamp. Equivalent timestamp offsets and legacy string timestamps resolve to the same key. Successful entries are retained for 30 days; old reset cycles are independently excluded, so retention cleanup does not make them eligible again.

Failed requests do not create success records and may be retried after a later fresh refresh. Invalid or unreadable history, or a history write failure after acceptance, pauses warmup until application restart. Repair the underlying storage problem before restarting; otherwise the same safety check pauses it again. Invalid configuration remains an error in the settings UI instead of being silently replaced with enabled defaults. A process crash after provider acceptance but before history persistence can cause another request after restart; execution is not exactly-once.

The proxy-gateway adapter uses the existing Claude mapper or the native Gemini envelope and `GeminiClient` transport. It starts with `streamGenerateContent?alt=sse`, falls back to `generateContent` on transport failure, and does not repeat an HTTP rejection as a non-streaming request. Both content methods preserve the project in the request body but omit `x-goog-user-project`, including after extra headers are merged. Non-content internal methods retain the bounded Google 403 project-header downgrade. A 60-second deadline and cancellation signal bound transport work. No internal HTTP endpoint or authentication bypass is exposed.

## 2. Technical Implementation

### 2.1 Database Design (`cloud_accounts.db`)

Account information is stored in SQLite, independent from the IDE's local database.

```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,          -- UUID
  provider TEXT NOT NULL,       -- 'google' | 'anthropic'
  email TEXT NOT NULL,          -- Email
  name TEXT,                    -- Display name
  avatar_url TEXT,              -- Avatar URL
  token_json TEXT NOT NULL,     -- OAuth token (JSON)
  quota_json TEXT,              -- Quota data (JSON)
  created_at INTEGER NOT NULL,  -- Created timestamp
  last_used INTEGER NOT NULL,   -- Last-used timestamp
  status TEXT DEFAULT 'active', -- Account status
  is_active INTEGER DEFAULT 0   -- Whether this is the currently active IDE account
);

-- Global settings table
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### 2.2 IPC Interface Design

The backend exposes the following oRPC interfaces via `src/ipc/cloud`:

- `addGoogleAccount(authCode: string)`: Exchange token and save account.
- `listCloudAccounts()`: Get account list.
- `refreshAccountQuota(accountId: string)`: Refresh quota and token for a specific account.
- `switchCloudAccount(accountId: string)`: Run the account switch workflow.
- `deleteCloudAccount(accountId: string)`: Delete an account.
- `getAutoSwitchEnabled()` / `setAutoSwitchEnabled(enabled)`: Get/set auto-switch state.
- `forcePollCloudMonitor()`: Manually trigger background polling.

### 2.3 Token Injection Mechanism (`ProtobufUtils`)

The IDE stores authentication data in the `ItemTable` table of `state.vscdb`.
Older versions use `jetskiStateSync.agentManagerInitState`; newer versions use unified state keys such as `antigravityUnifiedStateSync.oauthToken`.
Values are Base64-encoded Protobuf binary.

We implemented `src/shared/serialization/protobuf.ts`, which can:

1. **Decode**: Parse Varint and length-delimited fields.
2. **Modify**: Locate and remove old Field 6 (`OAuthTokenInfo`).
3. **Merge**: Replace only the OAuth topic entry inside unified state while preserving unrelated topic entries.
4. **Rebuild**: Build a new Field 6 using new access/refresh tokens and insert it for legacy state.

### 2.4 Switching Workflow

1. **Token check**: Check whether the target account token is near expiration; refresh automatically if needed.
2. **Preflight and stop**: Resolve the selected installation and user data directory, reject conflicts, initialize missing identity storage and validate its JSON and write access, then stop the GUI process and confirm exit.
3. **Apply identity and inject token**: Apply the bound device profile before writing account credentials with the selected credential-store or SQLite strategy. Both steps use the captured context.
4. **Restart and confirm**: Dispatch one executable launch and confirm the main process within the startup deadline.
5. **Update state**: Mark the target account active only after confirmation. Startup failure reports that account data was updated without automatically launching again.

The [process operation reference](architecture.md#antigravity-process-operations) owns launch, concurrency and failure behavior. CLI targets skip the GUI stop/restart steps.

### Identity storage initialization

OAuth account addition, JSON account import, confirmed local account import and local account snapshots explicitly prepare desktop identity storage using the resolved desktop target and directory. Imports that do not persist any accounts do not initialize files. IDE synchronization prepares the selected target. GUI switching prepares the directory in its launch context, including a custom `--user-data-dir`. WSL native Linux targets use Linux directories. If no desktop executable is available, account collection can still prepare the host's native default profile; target conflicts and process query failures remain errors.

Only a missing `storage.json` is created, with generated device identifiers in the existing flat and nested telemetry format. An existing file is validated and preserved byte for byte during initialization. Malformed JSON, non-object content and filesystem errors are reported rather than replaced. Atomic exclusive publication preserves a file created concurrently by another process. SQLite state is created by the existing identity write or credential injection operation when required; initialization does not invent authentication records or modify the newer Hub's `app_storage.json`.

Read-only identity queries do not create files. CLI switching does not initialize desktop identity storage. Initialization failures during switch preflight leave the running application and its account credentials unchanged; failures after process shutdown remain explicit and do not trigger an automatic second launch.

### 2.5 Auto-Switch Logic (`AutoSwitchService`)

1. **Monitor**: `CloudMonitorService` polls quotas for all accounts every 5 minutes.
2. **Evaluate**: If all key model quotas or shared grouped quota buckets of the active account are below `5%`, or status is `rate_limited`.
3. **Select**: Filter accounts with `active` status and sufficient quota, then sort by remaining quota.
4. **Execute**: Automatically call `switchCloudAccount` and notify the user.

### 2.6 Proxy Lease Token Persistence

The proxy account lease makes refreshed access-token and resolved project-ID state available in its in-memory cache before durable persistence. Persistence is deferred to the next event-loop turn and serialized per account, so encrypted SQLite work does not delay the request that acquired the lease and an older write cannot overtake a newer token or project update. Different accounts persist independently. A deferred write failure is logged without invalidating the lease that already succeeded. Graceful gateway shutdown drains queued writes; an abrupt process exit can lose only the latest deferred update.

Account mutations outside this lease hot path keep their existing awaited persistence behavior.

### 2.7 Security Hardening

- **Key management**: Use native OS credential stores (Windows Credential Manager / macOS Keychain) via `keytar` to securely store the AES-256 master key.
- **Data encryption**: Encrypt all sensitive fields (`token_json`, `quota_json`) with `AES-256-GCM` before writing to SQLite.
- **Auto migration**: Automatically detect and migrate legacy plaintext data at startup to ensure a smooth security upgrade.
