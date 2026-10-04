# Coding Tool Configuration Reference

The proxy page configures Claude Code, Codex and OpenCode on the computer and under the user
running the selected Manager backend. An Electron renderer connected to a standalone core
changes the core user's files, not the renderer user's files. Installation detection is advisory;
settings can be saved before installing a client. Reopen clients after changing settings.

## Configure and recover

Choose a tool, select an available model and confirm configuration. The advanced address field
defaults to the current Manager gateway. Claude uses the gateway root; Codex uses its `/v1`
endpoint. The card distinguishes saved settings from verified model requests. Environment
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
- **Remove connection** restores prior owned connection fields and keeps later unrelated edits
  and the backup. A different active provider or changed connection key requires reading and
  configuring the current settings again before removal.
- **Restore backup** replaces the entire settings file with its first backup, overwriting later
  edits. If no file existed originally, the newly created file is removed. Successful restoration
  consumes the backup.
- OpenCode removal keeps other providers. Its optional account-plugin export stays off by default
  and requires a trusted computer. A direct-login plugin can use a different provider.

Original Claude/Codex backups may contain prior client credentials. See the private-file policy
in [security.md](security.md). Configuration and previews do not prove upstream availability.
Use the [live acceptance SOP](live-agent-acceptance.md) to verify requests and traffic records.

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
   node dist/cli/main.cjs tools configure codex --base-url http://127.0.0.1:8045/v1 --model gemini-3.1-pro-high
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

## Packaged desktop acceptance tutorial

Use a separately prepared profile with an existing gateway key, English UI preferences and
`desktop-embedded` ownership. The script refuses to overwrite an existing acceptance tool file.
It launches the supplied executable, configures through the UI, checks the written file and
hidden preview, removes the connection and restores the backup. Windows startup registration
is saved and restored; Linux uses `--no-sandbox` only for this isolated acceptance process.

```powershell
npm run test:acceptance -- agents configure --electron-bin <packaged-executable> --profile-home <isolated-profile> --output <report-directory> --client codex --bin <codex-executable> --live true
```

Repeat with `--client claude` and its executable, on each platform. `--live true` runs the existing
TODO request SOP using the actual UI-generated configuration, without connection overrides.
Omitting it checks configuration and recovery only. Reports state the failing step and whether
recovery finished. A failed run can leave its isolated tool settings and backup for diagnosis;
never point this script at a production profile. Screenshots capture only the tool cards.

Use `--model-name <visible-label>` to select a particular displayed model. When aliases share a
label, the script selects the first entry and records the actual model ID from the written file;
the displayed label alone is not evidence of the physical model used.
