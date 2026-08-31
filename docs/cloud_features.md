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

The proxy-gateway adapter uses the existing Claude mapper or the native Gemini envelope and `GeminiClient` transport. It starts with `streamGenerateContent?alt=sse`, falls back to `generateContent` on transport failure, and does not repeat an HTTP rejection as a non-streaming request. A 60-second deadline and cancellation signal bound transport work. No internal HTTP endpoint or authentication bypass is exposed.

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
2. **Stop process**: Gracefully stop the Antigravity process.
3. **Inject token**: Call `CloudAccountRepo.injectCloudToken` to update the IDE database.
4. **Update state**: Mark target account as `is_active = 1`, set others to `0`.
5. **Restart process**: Restart the IDE so it loads new credentials.

### 2.5 Auto-Switch Logic (`AutoSwitchService`)

1. **Monitor**: `CloudMonitorService` polls quotas for all accounts every 5 minutes.
2. **Evaluate**: If all key model quotas or shared grouped quota buckets of the active account are below `5%`, or status is `rate_limited`.
3. **Select**: Filter accounts with `active` status and sufficient quota, then sort by remaining quota.
4. **Execute**: Automatically call `switchCloudAccount` and notify the user.

### 2.6 Security Hardening

- **Key management**: Use native OS credential stores (Windows Credential Manager / macOS Keychain) via `keytar` to securely store the AES-256 master key.
- **Data encryption**: Encrypt all sensitive fields (`token_json`, `quota_json`) with `AES-256-GCM` before writing to SQLite.
- **Auto migration**: Automatically detect and migrate legacy plaintext data at startup to ensure a smooth security upgrade.
