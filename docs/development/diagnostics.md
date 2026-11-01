# Development Diagnostics

This guide covers optional renderer diagnostics and development-server connection checks. Basic log locations remain in [Development](../development.md#desktop-diagnostics).

## Optional diagnostics and connection checks

Sentry is enabled only when the relevant build configuration and credentials are present. Absence of Sentry in a local build is not evidence that the instrumentation path is broken.

React Scan is opt-in and development-only. Enable it for one local Electron session with:

```powershell
$env:ANTIGRAVITY_ENABLE_REACT_SCAN = '1'
pnpm start
```

Vite injects the diagnostic before the renderer entry only in that mode; production builds and CI do not reference it. When enabled, the current React Scan package performs its own version check against `react-grab.com`, so do not enable it in a development environment where that outbound request is prohibited.

Performance recording and local update-feed helpers live in `scripts/` and have dedicated pnpm commands. Use them only when the task concerns those paths; some operations create local artifacts or require platform-specific binaries.

The renderer development server binds to `127.0.0.1` so Electron can reach it even when IPv6 loopback is blocked. Forge supplies the actual port to the main process; its readiness probe bypasses proxy environment settings and times out each request after one second.
Run `pnpm run test:acceptance development connection` to verify the Vite listener and Forge URL with an isolated Electron window. This check does not open account storage or launch the gateway.

## Diagnose a blank or stale development window

On Windows, start the desktop app with `pnpm start` from the repository root. This runs Electron Forge with its Vite configuration. Do not launch `electron.exe .` directly: that bypasses Forge's renderer setup and can open a window that does not represent a valid development launch.

If the window is blank or appears to show an older build:

1. Check for an existing development instance before starting another. Forge instances can contend for the development profile and ports; a second Vite server may choose another port while the app remains attached to the first. Do not close the installed app without confirming with its user.
2. Wait for Forge's build and launch to finish. A launched process or Vite response alone does not confirm that the renderer is healthy.
3. Verify that the Vite URL printed by the current Forge process returns HTTP 200, then confirm the Electron renderer is attached to that same URL rather than a stale port or a `file://` renderer path.
4. Confirm that the window displays the React interface. If it remains blank, inspect the current Forge output, renderer DevTools console, and failed document or asset requests. Distinguish main-process failures from renderer failures before retrying.
5. Check that any required gateway listener belongs to the current development Electron process. Do not infer that startup completed from an occupied port alone.

Use process IDs and executable paths to identify the development process; do not terminate processes by a broad executable name. Do not delete the application profile or clear caches as a first response. Keep the Forge terminal open for the duration of the development session.
