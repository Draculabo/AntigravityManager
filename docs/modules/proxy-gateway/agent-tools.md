# Coding Tool Configuration Reference

The proxy page saves settings for supported coding tools under the operating system user running
the selected Manager backend. When the Electron renderer connects to a standalone core, Manager
writes to the core user's settings. Installation detection is advisory. You can save settings
before installing a client. Reopen the client after applying changes.

## Configure and recover

In **Gateway → Coding tools**, choose **Connect** on a tool's row. Manager writes the
current local gateway address and credentials, using models from eligible accounts with
observed quota. Set the Manager key under **Manual setup** for tools that require it.
OpenCode registers available models with its dedicated key and leaves account export off.
DSH needs an initialized `web` profile. Manager asks for confirmation before replacing an
existing Claude Code or Codex provider.

**Disconnect** removes the settings owned by Manager, including applied saved connections.
Manager asks for confirmation if it finds multiple active connections for the tool. Saved
profiles and their credential records remain available to the backend. The row's optional menu
provides read-only configuration previews and backup recovery where the tool supports them.

A saved configuration indicates that Manager wrote settings. Reopen the tool, send a
request and check **Traffic** to verify that it uses the gateway.

**Manual setup** contains the service address, API key and request examples. Edit listener
settings, request policies and record retention in **Gateway settings**. Application settings
links to the same page.

Claude uses the gateway root; Codex uses its `/v1` endpoint. Environment
variables, command-line overrides and direct-login plugins can override client settings.

Claude and Codex require an existing Manager proxy key. They do not change Google authorization,
Codex `auth.json`, client approval policy or sandbox permissions. Claude's default model family
settings use the selected model. Codex selects the `antigravity_manager` Responses provider and
uses its static authorization header. Configuration adds `codex-auto-review` model routing when
absent, preserves an enabled existing route and refuses a disabled route. That additive route
remains after restoring client settings because other profiles may use it.

| Client      | Settings location                                                      | Serialization and recovery                                                                                                    |
| ----------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `CLAUDE_CONFIG_DIR/settings.json`, otherwise `~/.claude/settings.json` | JSONC edits preserve existing comments and unrelated settings.                                                                |
| Codex       | `CODEX_HOME/config.toml`, otherwise `~/.codex/config.toml`             | `smol-toml` parses and serializes TOML. Values in unrelated tables remain; formatting is normalized and comments are removed. |
| OpenCode    | Existing OpenCode config discovery                                     | Existing JSONC synchronization and dedicated-key backup policy apply.                                                         |

Claude and Codex keep the original text in an adjacent `.antigravity-manager.bak` file before
the first write. Repeated configuration keeps that first backup. Backup failure stops the write;
invalid existing settings are not reset. Each file is replaced atomically, but client files and
Manager routing are not one transaction. An added routing entry can remain if the subsequent
client write fails. The original client backup remains available for recovery.

- **View configuration** shows only Claude/Codex connection fields with credentials hidden.
- **Disconnect** restores prior owned connection fields and keeps later unrelated edits
  and the backup. A different active provider or changed connection key requires reading and
  configuring the current settings again before removal.
- **Restore backup** replaces the entire settings file with its first backup, overwriting later
  edits. If no file existed originally, the newly created file is removed. Successful restoration
  consumes the backup.
- OpenCode removal keeps other providers. A direct-login plugin can use a different provider.

Original Claude/Codex backups may contain prior client credentials. See the private-file policy
in [security.md](../../security.md). Configuration and previews do not prove upstream availability.
Use the [live acceptance SOP](./acceptance/live-agent.md) to verify requests and traffic records.

## Independent connection profiles

The backend catalog can hold multiple plans for the same client. Each plan has a name, address,
supported protocol/SDK combination, model set and an existing backend credential source.
The existing Manager key, existing OpenCode dedicated key and the current client-configured key
are snapshot sources. They do not create new proxy keys. Profile credentials never enter public
IPC, previews or renderer state. Changing the source replaces only that saved profile's snapshot.

OpenCode, OpenClaw, DSH, Kimi Code and Pi receive an independent provider ID per saved connection. Qwen Code
identifies saved model entries by their key reference and disallows duplicate model routes. OpenClaw
allow tokens and default selections remain independently owned. Other provider nodes and later
unrelated changes survive removal. Claude, Codex and Hermes keep a library of saved connections
with one active native connection. Gemini CLI also uses one active native connection. Applying
another switches that connection; the prior plan
and credential remain saved. A saved or owned connection does not establish that the client
has loaded it or that a model request succeeds.

Save the profile before requesting an apply/remove preview. A stale saved revision, changed
native file, changed key or ownership receipt invalidates the preview. Remove its native
connection before deleting an applied saved profile or changing its client, DSH profile or
OpenClaw format. The library uses the selected backend's home and environment paths.

The version-1 catalog is `client-connection-profiles.json` in the Manager data directory.
Connection keys stay in separate OS-keyring accounts. Private originals, first backups and
write-intent state are encrypted with a keyring-owned encryption key. Preserve the catalog and
the original user's keyring together for recovery. An unavailable keyring or missing encryption
key stops operations without a plaintext fallback. Native writes and catalog finalization are
separate steps; an interrupted operation reports failure and reconciles known before/after
bytes on the next operation. Unexpected intervening changes require resolving the conflict.

## Hermes and OpenClaw configuration

Both cards use the selected backend's existing Manager proxy key. The key stays in the backend
and is written only to the client connection fields. Status and previews expose installation,
paths, endpoint, model IDs and explicit selection options without file contents or credentials.
Installation detection runs outside the write queue, with one version command bounded to five
seconds and 64 KiB. A found executable can have an unknown version. Settings can be saved before
installing either client; a saved file does not establish that a client has loaded it.

Hermes targets `HERMES_HOME/config.yaml`, otherwise `~/.hermes/config.yaml`. Its YAML document
adapter keeps comments and unrelated nodes. The `antigravity-manager` provider uses `api`,
`api_key`, `transport: chat_completions` and `discover_models`. Explicit model IDs are written
when discovery is off. Conflicting credential or endpoint aliases in that provider are refused.
Only explicit default activation changes `model.provider` and `model.default`.

### Compact Hermes system prompt

If a full Hermes tool-enabled request receives upstream HTTP 429
`RESOURCE_EXHAUSTED`, add the following header to the existing Manager provider
entry in Hermes `config.yaml`, then start a fresh Hermes session.

```yaml
providers:
  antigravity-manager:
    extra_headers:
      X-Antigravity-Hermes-Prompt: compact
```

This opt-in applies to `POST /v1/chat/completions` when the first message is a
plain-text system message starting with a known default Hermes identity. The
gateway replaces that message with `Answer briefly.` before mapping the request.
Hermes may have embedded workspace rules, memory and skill guidance in that
message. Use the mode in sessions where that bundled context can be omitted.
Separate instructions, the conversation, tool declarations and tool results
continue through the normal mapper. The mode applies to streamed and non-streamed
Chat requests. Unrecognized system messages, including auxiliary prompts and
custom identities, follow ordinary mapping. Remove the header to disable the mode.

### Kimi Code provider

Select **Kimi Code** in Connection profiles to connect Kimi Code CLI 2.x through
OpenAI Chat Completions. The backend uses `KIMI_CODE_HOME/config.toml` or
`~/.kimi-code/config.toml`. Applying the reviewed connection adds one provider and
one model alias per selected gateway model. The alias is available in Kimi Code's
model picker. Manager uses its model catalog to supply the required context limit.

Keep the optional default model field empty to retain Kimi Code's default. An explicit default
is restored on removal if it still matches the applied value. Removal removes
the owned provider and model aliases. If Kimi Code saved an owned model as its
default independently, select another default in Kimi Code before removing it.
The TOML document is reserialized, so
comments and formatting may change. The original bytes are retained in the
connection profile's encrypted first backup.

### Qwen Code, Gemini CLI and Pi

Choose the client in Connection profiles and review the plan before applying it. Leave the optional
default model field blank to keep the current model selection. Reopen the client after applying and
confirm a request in Traffic Monitor.

| Client     | Configuration                                                                                                                                                                                                                 | Protocol                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Qwen Code  | `QWEN_HOME/settings.json` or `~/.qwen/settings.json`. Manager adds model entries under the OpenAI provider with a profile-specific key in the native `env` settings.                                                          | OpenAI Chat Completions |
| Gemini CLI | `$GEMINI_CLI_HOME/.gemini` or `~/.gemini`. Manager writes the gateway address and API key to `.env` and selects API-key authentication in `settings.json`. Pick a model in Gemini CLI or set the optional default in Manager. | Native Gemini           |
| Pi         | `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. Manager adds a provider and models with context and output limits to `models.json`. An explicitly selected default also updates `settings.json`.                                     | OpenAI Chat Completions |

An authorized multi-file operation is journaled before the first write. If it stops between files,
the owner completes the remaining write only when both files still match the recorded versions. If
either file changed externally, Manager reports a conflict. Removing a connection restores its
unchanged owned fields and preserves unrelated configuration. If Qwen Code or Pi has independently
selected a managed default, select another model before removing the provider.
Gemini CLI applies its own workspace trust and environment precedence when reading `.env`.
Use its normal workspace trust flow and check for local environment overrides when testing a connection.

### OpenClaw provider

OpenClaw targets `OPENCLAW_CONFIG_PATH`, otherwise `OPENCLAW_DIR/openclaw.json` or
`~/.openclaw/openclaw.json`. JSONC edits keep comments and unrelated nodes. The selected `v1`
format owns individual Manager entries in `agents.defaults.models`; `v2` owns only its
`antigravity-manager/*` token in an existing restrictive `agents.defaults.modelPolicy.allow`.
An absent or empty allow list stays unrestricted. Quick setup uses `v2` and preserves `models.mode`.
Changing formats removes
only entries recorded by Manager. Personal allow entries remain. Provider fields use `baseUrl`,
`apiKey`, `api: openai-completions` and the selected model IDs. Model capabilities are not guessed.
`models.mode` stays unchanged by default. The separate merge option previews and changes that
global field explicitly. Only explicit activation changes `agents.defaults.model.primary`.

Apply and remove require a preview whose hash covers both the configuration and ownership
receipt. Each backend admits at most 32 queued writes or previews and 32 independent status
operations. Shutdown closes admission and drains both groups before releasing the backend.
The owner keeps an exclusive first `.antigravity-manager.bak` with the original file text or
original absence. Backups, receipts and replacement files use private creation permissions.
On Windows, the backend user's directory permissions govern access. Configuration and receipt
reads are limited to 1 MiB; unsafe or malformed files are refused.

Replacement uses a unique temporary file, a final source comparison and readback. The adjacent
`.antigravity-manager.owner` receipt records each field's previous value and written hash.
Removal restores a value only while it still matches that hash, so changed managed fields cause
a conflict. Only newly created parent mappings that remain empty are pruned. Later personal fields remain. Default activation is retained unless explicitly
changed or removed; removing its selected model from a later sync requires a new explicit
selection. Whole-file backup restoration is not exposed by these cards.

Configuration and receipt are separate writes. `data.clientConfigCode: receipt-failed` means
the client file may already have changed and ownership was not confirmed. Inspect the file and
first backup before further changes. `write-unconfirmed` also requires inspection. Neither
error means that rollback completed. Both clients must be reopened after configuration changes.

## DSH profile configuration

The DSH card uses the selected backend user's `DSH_HOME` or `~/.dsh`, and reads
`profiles/<profile>/cordis.patch.yml` inside that directory. Quick setup targets the existing
`web` profile. The selected profile must contain one supported
llm-pi-ai entry with a providers mapping. Preview shows the Manager provider, protocol, endpoint,
models and credential reference. Existing-reference mode leaves credential provisioning to DSH.
The explicit Manager-key option supports only the declared native version-1 credentials-local
store without a custom path. Unknown declarations, unsafe permissions or unsupported formats
are refused. Credential values stay in the backend and its native store.

Default-model activation is separate. It requires a recognized agent-default-model entry and a
model in the submitted list. Removal restores the exact unchanged owned default, preserving a
later personal selection. The profile library uses independent provider/credential namespaces.

Apply/remove consume a reviewed profile, ownership and relevant credential snapshot. The owner
uses native exclusive locks, private first backups, source comparisons and readback. Changed or
unowned managed nodes cause a conflict. Cleanup retains credentials referenced by another
provider or profile, or whose unreferenced ownership cannot be established. Profile, credential
and receipt writes are separate. A partial failure requires inspection of the files and backups;
it does not establish rollback and is never automatically replayed.

Other composition patches and launch-environment values can override the saved profile. Disk
persistence does not establish effective running configuration, credential availability in a
separately launched client, or a successful request. Verify those through the original real-client
acceptance when authorized. The installed Windows DSH client loaded a synthetic isolated profile
through `--dump-config` and included its Manager provider, model and gateway address. Live
credential use and generation require separate acceptance.

The SOP accepts `--client-settings PATH` for Claude/Codex directories produced by one-click
configuration. This mode does not supply model, provider, endpoint or authorization overrides
and does not rewrite those files. Use an isolated tool directory; client history still changes
during execution. Audit collection remains authorized separately by the existing profile key.
Claude's restricted SOP mode skips normal user settings, so this mode explicitly supplies the
generated `settings.json` using `--settings`. Ordinary interactive Claude reads its user settings
without that SOP flag.

## Standalone CLI tutorial

1. Start a prepared standalone runtime with a configured gateway and proxy key.
2. Inspect and configure a client using a model available through that gateway:

   ```powershell
   node dist/cli/main.cjs tools status codex --base-url http://127.0.0.1:8045/v1
   node dist/cli/main.cjs tools configure codex --base-url http://127.0.0.1:8045/v1 --model gemini-3.8-flash-high
   ```

3. Reopen the client and verify its requests in Manager's Traffic Monitor. Saved configuration
   alone is insufficient evidence. `claude` and `opencode` are also supported tool arguments.
4. Review recovery impact before using either command:

   ```powershell
   node dist/cli/main.cjs tools remove codex --yes
   node dist/cli/main.cjs tools restore codex --yes
   node dist/cli/main.cjs tools remove opencode --yes --base-url http://127.0.0.1:8045/v1
   ```

The CLI starts or connects to its selected core before an operation. Invalid tool/address/model
arguments and missing recovery confirmation fail before starting the core. It prints safe status
and fixed error categories rather than file contents or credentials.

### Configure a DSH profile from the CLI

Set `DSH_HOME` in the standalone Core environment before starting it if the DSH directory differs
from `~/.dsh`. Use the name of an existing
DSH profile. The CLI uses the same selected Core owner as the desktop DSH card.

1. Check the profile and preview the change. Repeat `--model` to offer multiple models.

   ```powershell
   $dshOptions = @(
     '--profile', 'web', '--protocol', 'openai-completions',
     '--base-url', 'http://127.0.0.1:8045/v1',
     '--credential-ref', 'manager_key', '--model', 'gemini-3.8-flash-high'
   )
   node dist/cli/main.cjs tools dsh status --profile web
   node dist/cli/main.cjs tools dsh preview --action sync @dshOptions
   ```

   `--credential-ref` is a credential name in DSH. The default `existing-reference` mode keeps
   credential provisioning with DSH. Use `--credential-mode manager-key` to ask the owner to
   provision the existing Manager key when the profile supports the native store. Use
   `--activate-model <id>` if you want to change the profile's default model.

2. Review the endpoint, models, and credential and default actions in the JSON preview. Use the
   same options for `apply` and copy the `sourceHash` from that preview.

   ```powershell
   node dist/cli/main.cjs tools dsh apply @dshOptions --source-hash '<preview hash>' --yes
   ```

   A conflict means the owner rejected the write because the reviewed source changed. Preview
   again and review the latest state. A receipt failure may follow a partial write. Inspect the
   profile and its first backup before retrying.

3. Reopen DSH and send a request. Check Manager's Traffic Monitor to confirm which gateway and
   model handled it.
4. To remove the Manager connection, review a removal preview and use its own `sourceHash`.

   ```powershell
   node dist/cli/main.cjs tools dsh preview --profile web --action remove
   node dist/cli/main.cjs tools dsh remove --profile web --source-hash '<removal preview hash>' --yes
   ```

## Packaged desktop acceptance tutorial

Use a separately prepared profile with an existing gateway key, at least one eligible account
with observed text-model quota, English UI preferences and `desktop-embedded` ownership. The
script refuses to overwrite an existing acceptance tool file.
It launches the supplied executable, configures through the UI, checks the written file and
hidden preview, removes the connection and restores the backup. Windows startup registration
is saved and restored; Linux uses `--no-sandbox` only for this isolated acceptance process.

```powershell
pnpm run test:acceptance agents configure --electron-bin <packaged-executable> --profile-home <isolated-profile> --output <report-directory> --client codex --bin <codex-executable> --live true
```

Repeat with `--client claude` and its executable, on each platform. `--live true` runs the existing
TODO request SOP using the actual UI-generated configuration, without connection overrides.
Omitting it checks configuration and recovery only. Reports state the failing step and whether
recovery finished. A failed run can leave its isolated tool settings and backup for diagnosis;
never point this script at a production profile. Screenshots capture only the tool cards.

The acceptance runner reads the actual model ID selected by Manager from the written file.

Independent connection profiles require the original owner keyring for credential and recovery access. Read the [connection profile upgrade and recovery guide](../../upgrade-guides/next/connection-profiles.md) before copying profiles, resetting credentials or downgrading. Its recovery procedure is not runtime-verified for this source snapshot.
