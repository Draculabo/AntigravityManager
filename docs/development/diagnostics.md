# Development Diagnostics

This guide covers optional renderer diagnostics and development-server connection checks. Basic log locations remain in [Development](../development.md#desktop-diagnostics).

## Optional diagnostics and connection checks

Sentry is enabled only when the relevant build configuration and credentials are present. Absence of Sentry in a local build is not evidence that the instrumentation path is broken.

React Scan is opt-in and development-only. Enable it for one local Electron session with:

```powershell
$env:ANTIGRAVITY_ENABLE_REACT_SCAN = '1'
npm start
```

Vite injects the diagnostic before the renderer entry only in that mode; production builds and CI do not reference it. When enabled, the current React Scan package performs its own version check against `react-grab.com`, so do not enable it in a development environment where that outbound request is prohibited.

Performance recording and local update-feed helpers live in `scripts/` and have dedicated npm commands. Use them only when the task concerns those paths; some operations create local artifacts or require platform-specific binaries.

The renderer development server binds to `127.0.0.1` so Electron can reach it even when IPv6 loopback is blocked. Forge supplies the actual port to the main process; its readiness probe bypasses proxy environment settings and times out each request after one second.
Run `npm run test:acceptance -- development connection` to verify the Vite listener and Forge URL with an isolated Electron window. This check does not open account storage or launch the gateway.
