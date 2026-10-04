# Live media and thinking acceptance tutorial

This tutorial checks the live gateway through each Windows/Linux and standalone CLI/Electron
owner combination. Use the [agent task SOP](live-agent-acceptance.md) for complete coding tasks
and Traffic Monitor UI comparisons; media and thinking reports are separate evidence.

## Prepare each owner

1. Use an isolated profile with authorized test accounts, a configured gateway key and model
   quota. Keep other clients idle during each measured request window.
   Use a native checkout with its platform's npm dependencies. Windows `node_modules` cannot
   supply Linux `sharp` binaries; run the owning npm setup in a Linux checkout or reuse an
   already prepared Linux dependency workspace for isolated acceptance.
2. Start the standalone service for a CLI cell. For an Electron cell, stop the standalone owner
   and prepare `desktop-data/desktop-preferences.json` with `preferences.owner_mode` set to
   `desktop-embedded`. Supply a native packaged executable to the Electron wrapper.
3. Run each case against a loopback gateway. Profile keys are read in memory, never supplied
   as command arguments. Reports exclude authorization, account identities and response bodies.
4. On Windows, snapshot and restore the application's login settings around native acceptance
   with the existing `scripts/acceptance/helpers/windows-login-settings.mjs` helper. Use an isolated Linux D-Bus
   session with an unlocked test keyring. The Electron wrapper uses `--no-sandbox` on Linux for
   WSL acceptance; this does not certify production Chromium sandbox operation.

`--owner electron` alone labels a direct runner; it does not prove a desktop owns the gateway.
Use the wrapper, which checks the real renderer and gateway and closes the native process.

## Media cases

Run all nine cases for each platform and owner:

| Case                                 | Compatibility surface    | Evidence                                                               |
| ------------------------------------ | ------------------------ | ---------------------------------------------------------------------- |
| `chat-image`, `chat-video`           | OpenAI Chat              | Red image; red then blue video                                         |
| `responses-image`                    | OpenAI Responses         | Red image                                                              |
| `gemini-image`, `gemini-video`       | Gemini                   | Red image; red then blue video                                         |
| `anthropic-image`, `anthropic-video` | Anthropic compatibility  | Red image; red then blue video                                         |
| `image-generate`                     | OpenAI Images generation | Decodable image with predominantly red rather than blue colored pixels |
| `image-edit`                         | OpenAI Images editing    | Decodable image with predominantly blue rather than red colored pixels |

Anthropic video is a gateway extension, not a claim about the official Anthropic API.
The input model defaults to `gemini-3.1-pro-high`; generation/editing default to
`gemini-3.1-flash-image`. `--model` explicitly selects another available model.

```powershell
npm run test:acceptance -- multimodal request --case chat-video --owner cli --gateway http://127.0.0.1:PORT --profile-home C:\path\to\isolated-profile --output C:\path\to\results
```

```bash
npm run test:acceptance -- multimodal electron --electron-bin /path/to/antigravity-manager --multimodal-case image-edit --gateway http://127.0.0.1:PORT --profile-home /path/to/isolated-profile --output /path/to/results
```

The SOP uses only bundled synthetic fixtures. It checks the HTTP result, semantic recognition,
one matching model audit record, consistent final status and complete response. Application
operations cannot crowd model records out of its audit page; a truncated model page fails.
Upstream retries and nullable token metrics remain in the report.

Image output is decoded with the existing `sharp` dependency, limited to 16,777,216 pixels and
sampled at up to 64 by 64 pixels. A requested color must occupy at least 5% of pixels and more
than twice the opposite color's pixels. This checks the color transformation, not exact square
geometry or artistic quality. Reports contain fractions, not image content. Earlier reports
without `colorFractions` checked image bytes only; redacted audit bodies cannot upgrade them
to semantic passes. Rerun the affected cases.

## Two-turn thinking and tool continuation

Run `openai`, `anthropic` and `gemini` for each platform and owner:

```powershell
npm run test:acceptance -- thinking request --protocol openai --owner cli --gateway http://127.0.0.1:PORT --profile-home C:\path\to\isolated-profile --output C:\path\to\results
```

```bash
npm run test:acceptance -- thinking electron --electron-bin /path/to/antigravity-manager --thinking-protocol anthropic --gateway http://127.0.0.1:PORT --profile-home /path/to/isolated-profile --output /path/to/results
```

The first turn must call `lookup_number` exactly once with no arguments. The SOP returns the
synthetic number 17, keeps the original assistant history, including thought/signature fields,
and asks the same model to continue. The second turn must finish without another tool call and
return 391. This exercises signed history across a real tool result rather than a single prompt.

A pass requires two completed HTTP 200 audit records, observable public reasoning fields or
positive reported reasoning tokens, the correct final answer and a healthy Thought Store with
no additional write failures. Reports retain thought block/byte counts, per-turn tokens and
retry statuses, never thought text or signatures. A worker being alive alone cannot prove thinking.
The default model is `gemini-3.1-pro-high`; a pass using it does not certify Claude quota or every
model family. These calls are non-streaming; streaming is covered separately by agent tasks and
focused protocol tests.

## Interpret results and retry

Keep failed runs alongside successful ones. An upstream 429 recovered before a complete response
is visible but does not fail the final request. `QUOTA_EXHAUSTED` with a long reset delay requires
an account with available quota or a later rerun; repeatedly changing the prompt is not evidence
of a fix. A gateway 503 with no upstream attempt can reflect all eligible accounts being unavailable.

Null token metrics mean unavailable, not zero. Measured token usage is not a normal-cost verdict
without a reviewed baseline for that model, protocol, owner and platform. Provider costs for failed
attempts can be unreported. This matrix does not establish 100% headless feature coverage, audio,
video generation, every media format, all models or bare-metal Linux behavior.
