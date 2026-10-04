# Live Agent Acceptance SOP

This is an ordered tutorial for a real agent task against the packaged Antigravity Manager gateway.
It validates the model request path, upstream retries, client tool use, final file delivery, Thought
Store health and reported token usage. The task asks each client to create one standalone
`todo.html`; it does not test the page's UI interactions.

## Prerequisites

1. Use an isolated Antigravity Manager profile with a test Google account and a configured local
   gateway API key. Enable traffic audit and Thought Store in that profile.
2. Install the current Claude Code, Codex and OpenCode binaries for the test host. Record their
   versions with their own `--version` commands. OpenCode v2 is the default runner format;
   `--opencode-major 1` supports a deliberate v1 compatibility run.
3. Start exactly one gateway owner for that profile. For the CLI case, launch the packaged
   `standalone/cli/main.cjs service start` through its packaged Node runtime and confirm
   `service status`. For the Electron case, stop the standalone owner and select desktop-embedded
   ownership in the isolated desktop profile before using the Electron wrapper below. The
   wrapper checks the saved owner mode, opens a real renderer, runs the client and closes the
   desktop. `--owner` in the direct runner only records the operator's assertion; the HTTP
   endpoint alone does not reveal its owner process.
4. Run one client at a time. The audit correlates requests by time window and protocol across
   all models, including automatic-review models. Concurrent clients using the same protocol
   can contaminate the report even when they use different models.
5. For Codex automatic approval, check that the gateway can route its separate
   `codex-auto-review` model. The main task's model setting does not select that model. Use the
   existing model-alias settings in the isolated Manager profile to select a supported review
   model, record the chosen target, and retain failed runs from before that configuration.
   Keep automatic review and the workspace sandbox enabled; a review API failure can cause
   the client to decline an otherwise valid task command.

The runner reads the existing key from `<profile-home>/.antigravity-agent/gui_config.json`, or
from `AGM_ACCEPTANCE_API_KEY` when set. It passes the key only to the selected client and the local
gateway. It never prints or writes the key. Generated homes, client settings, workspaces and JSON
reports are placed in the chosen output directory; keep this directory private and remove it with
the platform's normal file tools after reviewing the reports.
The runner also sets the child's `PWD` to its fresh workspace. This matters on WSL because a
client can otherwise treat the caller's repository directory as its active location despite a
different process working directory.
For Claude Code, it clears inherited output-cap and thinking environment overrides before applying
any explicit acceptance option, so a stock run is reproducible.

## Run the four owner/platform cells

Use the installed binary paths and profile directories for each platform. `--gateway` must be a
loopback HTTP origin. The same command is run once for `claude`, `codex` and `opencode` in each cell.

```powershell
npm run test:acceptance -- agents task --client codex --owner cli --gateway http://127.0.0.1:PORT --profile-home C:\path\to\isolated-profile --output C:\path\to\private-results --bin C:\path\to\codex.exe
```

```bash
npm run test:acceptance -- agents task --client opencode --owner electron --gateway http://127.0.0.1:PORT --profile-home /path/to/isolated-profile --output /path/to/private-results --bin /path/to/opencode --opencode-major 2
```

Replace `--client`, `--owner`, the platform paths and port for each cell. The runner always creates
a fresh workspace, so a previous client's `todo.html` cannot make another client pass. The fixed
prompt and task ID are in `scripts/acceptance/agents/summarize.mjs`. A timeout can be changed
with `--timeout-ms`; the default is five minutes.

For an Electron cell, prepare `desktop-data/desktop-preferences.json` under the isolated profile
with `preferences.owner_mode` set to `desktop-embedded`, then use the wrapper instead of launching the
desktop separately. It checks the renderer before starting the same task runner and closes the
desktop afterward. Do not use a profile currently owned by a standalone core.

Add `--traffic-monitor true` to an Electron agent run to keep Traffic Monitor open during the
task and compare every matching request with its persisted audit afterward. This requires an
English desktop profile. The check searches each request ID, compares status and input/output
tokens in the row and detail dialog, compares retry count/statuses, refreshes the list, and verifies
that status filters include and exclude the request. It saves a separate `traffic-ui-report.json`
beside the task report. A failed task can still have an accurate monitor; keep both verdicts.
The monitor check does not copy credentials, export bodies, or inspect private reasoning text.

```powershell
npm run test:acceptance -- agents electron --electron-bin C:\path\to\antigravity-manager.exe --client codex --bin C:\path\to\codex.exe --gateway http://127.0.0.1:PORT --profile-home C:\path\to\isolated-profile --output C:\path\to\private-results
```

```bash
npm run test:acceptance -- agents electron --electron-bin /usr/bin/antigravity-manager --client opencode --bin /path/to/opencode --gateway http://127.0.0.1:PORT --profile-home /path/to/isolated-profile --output /path/to/private-results --opencode-major 2
```

For a repeatable token regression gate, establish an accepted baseline per client, platform,
owner and model. Then pass `--max-input-tokens` and `--max-output-tokens` with reviewed limits.
Without limits, the report provides measured usage but does not call it normal merely because the
HTTP requests succeeded. Token totals are the gateway's reported parent-request usage; failed
upstream attempts may have unreported provider-side cost.

Codex uses `--approve-for-me` by default. `--codex-approval never` selects its `workspace-write`
sandbox without approval prompts for a separate diagnostic run. Commands requiring approval may
then be rejected, especially during native Windows sandbox setup. Retain both reports and
diagnose the rejection; changing approval mode alone does not establish a repair. The report
records the selected mode. Do not use an unrestricted Codex sandbox for this acceptance.

Claude Code uses its stock system prompt by default. If a stock run receives only upstream 429s,
try `--claude-system-prompt compact` as a separate diagnostic run. This uses Claude Code's
`--system-prompt` option while retaining its native file tools and the same fixed task. The report
labels this mode. A compact-mode pass demonstrates the gateway and tool path, but does not turn a
failed stock-mode run into a pass; retain both results.
`--claude-max-output-tokens 4096` sets Claude Code's supported
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` environment variable for another separate diagnostic run. Keep
the cap in the report and compare it with the stock run. This does not disable model thinking.

## Read the report

The command prints the report path and a small verdict. `report.json` contains each gateway
request's protocol, local route, final status, upstream attempt statuses, duration, request and
response size, reported input/output/reasoning tokens, and completion state. It also contains
client event and tool-state counts, artifact size, Thought Store write-failure delta, and a list of
failed gates. It deliberately excludes prompts, response bodies, thought text, account identity,
authorization headers and API keys.

`stderrSignals` are diagnostic hints rather than upstream-status evidence. Quota hints require
an explicit error phrase or HTTP-status context; directory names containing `quota` and stack
line numbers such as `429` do not count. A client startup failure with no audit requests must
be diagnosed before attributing the failure to the gateway.

The task passes only when the client exits successfully, emits a final result, creates
`todo.html`, produces at least one matching loopback gateway request, has no failed final gateway
request or partial response, and does not increase Thought Store write failures. A recovered
upstream 429 remains visible in `upstream429Attempts` without failing a successful final request.
`reasoningTokens: null` means the provider did not report that metric; it does not establish that
the model did no reasoning. Use client event order, tool outcomes and Thought Store health to
assess the observable thinking/tool path, without reading private chain-of-thought content.

After running the matrix, pass its report paths to the aggregate command to print a compact
comparison. Keep failed runs in the table; a successful gateway request can still lack an HTML
artifact or have declined tools.

```bash
npm run test:acceptance -- agents report /path/to/first/report.json /path/to/second/report.json
```

If a run fails, retain its report and the generated workspace until the client, gateway and owner
failure classes are diagnosed. Record any external quota or account limitation separately from a
gateway or client defect. Do not substitute a one-message smoke request for this task acceptance.

## Recheck saved audit and desktop evidence

The runner selects `trafficClass=model` before paging the audit window. It requires complete
pages and rejects windows above 1,000 records rather than silently truncating them. Application
operation records therefore cannot crowd model requests out of the task report. Keep other clients
idle during collection, and retain the profile's audit data until the comparison is complete.
Requests made by automatic approval review remain in the task's protocol window even when they
use another model. Their failures and reported tokens contribute to the same audit verdict and
totals; filtering only the selected task model would hide this activity.

To correct an earlier report collected with a truncated audit window, start the same profile's
gateway and run the following command. It preserves `report.json`, writes `report.reconciled.json`,
and recomputes the task verdict from the complete saved model window. It does not run the client
again; client events, artifact checks and Thought Store snapshots still refer to the original run.

```bash
npm run test:acceptance -- agents report --refresh /path/to/isolated-profile /path/to/report.json
```

To compare the real desktop with an existing Electron task report, stop any standalone owner and
add `--traffic-monitor true --task-report /path/to/report.reconciled.json` to the Electron wrapper
command. `--output` remains required. The wrapper verifies the report's client, owner and gateway,
opens the same profile, and checks the saved requests without issuing another task. Its output
marks `taskReportReused: true`; a failed original task still returns a failing task exit code even
when the separate `traffic-ui-report.json` passes. Missing or expired audit records fail the check.

## Media, thinking and shell diagnostics

Use the [media and thinking tutorial](live-proxy-media-thinking-acceptance.md) for synthetic
image/video cases and a two-turn tool result with preserved thinking history.

`--codex-shell-profile disabled` supplies Codex's `allow_login_shell=false` process option for
a separate PowerShell startup diagnostic. The default remains unchanged. It does not alter
generated one-click settings, model, endpoint or credentials. Preserve the default run and
report the selected mode; a diagnostic artifact or HTTP 200 alone cannot turn a failed task
into a pass. The one-click desktop SOP also forwards this explicit diagnostic option.
