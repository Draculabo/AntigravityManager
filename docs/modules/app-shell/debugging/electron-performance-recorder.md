# Electron Performance Recorder

The performance recorder is an opt-in development tool for diagnosing UI stalls across the
Electron main, renderer, GPU, and utility processes. It is disabled unless
`ANTIGRAVITY_ENABLE_PERFORMANCE_RECORDER=1` is present when Electron starts.

## Record the rapid-click scenario

Start the development app in one terminal:

```powershell
npm run start:performance
```

Wait until the application window is ready, then run the stress scenario in another terminal:

```powershell
npm run test:performance
```

The default scenario assumes the Manager UI is in English and rapidly clicks the `button` whose
accessible name is `Open service status` 50 times. Set the Manager language to English before
running the test. Override the target with a CSS selector, or change the count, when diagnosing
another interaction:

```powershell
$env:ANTIGRAVITY_PERFORMANCE_SELECTOR='button[aria-label="Open settings"]'
$env:ANTIGRAVITY_PERFORMANCE_CLICK_COUNT='100'
npm run test:performance
```

The development debugging endpoint listens only on `127.0.0.1:9333`. Override the port in both
terminals with `ANTIGRAVITY_PERFORMANCE_DEBUG_PORT` if necessary.

Stop the normal development instance before running `npm run start:performance`. Performance mode
uses the same Manager data as a normal development run, so only exercise UI paths that are safe
against the current local accounts and configuration. The recorder itself only reads process
metrics and writes trace artifacts.

## Artifacts

Each run creates a session directory under `test-results/performance`:

```plaintext
test-results/performance/<session-id>/
├─ electron-trace.json
├─ app-metrics.json
├─ event-loop-delay.json
├─ renderer-long-tasks.json
├─ rapid-click-scenario.json
└─ summary.json
```

- `electron-trace.json`: Chromium/Electron multi-process trace for Perfetto.
- `app-metrics.json`: CPU and working-set samples from `app.getAppMetrics()` every 250 ms.
- `event-loop-delay.json`: Electron main event-loop histogram and timestamped delay samples.
- `renderer-long-tasks.json`: renderer Long Tasks and Event Timing entries.
- `rapid-click-scenario.json`: click latency, renderer heartbeat, and the combined summary.
- `summary.json`: maximum delays and threshold results used by the Playwright assertion.

Open `electron-trace.json` locally in [Perfetto](https://ui.perfetto.dev/). The recorder does not
upload artifacts.

## Pass criteria

The current scenario fails when either condition is observed:

- Electron main event-loop delay reaches 200 ms.
- A renderer Long Task reaches 200 ms.

It also requires a renderer animation-frame heartbeat within one second. These are regression
guards rather than claims that every interaction should consume the entire 200 ms budget.
