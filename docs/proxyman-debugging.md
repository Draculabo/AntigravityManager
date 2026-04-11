# Proxyman Debugging Guide for Antigravity and Antigravity Manager

This guide explains how to use Proxyman for two debugging targets:

1. The installed official `Antigravity` desktop client
2. The `Antigravity Manager` development build from this repository

Before you start, complete [Proxyman Installation and Basic Setup on Windows](./proxyman-install.md).

## Scope

Use this guide when you want to:

- inspect login, quota, project context, or model-list requests from `Antigravity`
- inspect OAuth, quota refresh, or proxy traffic from `Antigravity Manager`
- compare requests from the official client with requests produced by this project

## Understand the Two Traffic Paths

### Official `Antigravity` Client

`Antigravity` is an Electron application. Its traffic may come from:

- Chromium or renderer-side requests
- Electron or Node-side requests

### `Antigravity Manager` in This Repository

This project is also an Electron app, but it additionally includes Node, Undici, and internal proxy flows. You may need to inspect:

- Electron main-process outbound requests
- renderer-side requests
- upstream requests emitted by `src/server/`

## Debug the Installed Official Antigravity Client

### Recommended Path: Use the Repository Script

Use the provided script:

- [scripts/start-antigravity-with-proxyman.ps1](../scripts/start-antigravity-with-proxyman.ps1)

This should be the default path for the installed official client because it already does the following:

- sets `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY`
- sets `NODE_EXTRA_CA_CERTS`
- passes `--proxy-server` and `--proxy-bypass-list`
- stops existing `Antigravity` processes so the new environment takes effect

Typical usage:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-antigravity-with-proxyman.ps1
```

If Proxyman is using a different port:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-antigravity-with-proxyman.ps1 -Port 9091
```

If you are temporarily debugging TLS failures:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-antigravity-with-proxyman.ps1 -AllowInsecureTls
```

Notes:

- This script targets the installed official `Antigravity` client.
- It does not launch this repository's `Antigravity Manager` development build.
- Override `-AppPath`, `-CaPath`, `-ProxyHost`, or `-NoProxy` if your local environment differs.

### Suggested Flow

1. Open Proxyman.
2. Confirm that installation and certificate setup are already complete.
3. Confirm the local proxy port, for example `9090`.
4. Launch `Antigravity` with the script.
5. Trigger a request that is easy to identify, such as:
   - Google sign-in
   - model list loading
   - quota refresh
   - a generated request or prompt action

### Why Manual Parameters Are Still Documented

The script is the recommended default, but the raw parameters are still useful because:

- contributors may want to understand exactly what the script configures
- some people launch from VS Code, another shell, or a custom wrapper
- some debugging sessions need a partial override rather than the full script

### If Windows System Proxy Is Not Enough

In some environments you may still need to point the system proxy to Proxyman manually. At minimum, verify:

- HTTP proxy: `127.0.0.1:9090`
- HTTPS proxy: `127.0.0.1:9090`
- the bypass list is not excluding the domains you want to inspect

### If You Need Direct Chromium Proxy Arguments

If system proxy behavior is unreliable, you can launch the installed client with explicit Chromium proxy arguments:

```powershell
& "C:\Users\<YourUser>\AppData\Local\Programs\Antigravity\Antigravity.exe" `
  --proxy-server="http://127.0.0.1:9090" `
  --proxy-bypass-list="<local>;localhost;127.0.0.1;::1"
```

Use this as a fallback, not the default path.

## Debug Antigravity Manager From This Repository

This project has more layers than the official client. The script above is not the general launcher for this repository's development app.

### Capture Main-Process, Node, and Internal Proxy Traffic

Set proxy-related environment variables before starting the app:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:9090"
$env:HTTPS_PROXY = "http://127.0.0.1:9090"
$env:ALL_PROXY = "http://127.0.0.1:9090"
$env:NO_PROXY = "localhost,127.0.0.1,::1"
$env:NODE_EXTRA_CA_CERTS = "$env:APPDATA\\Proxyman\\certificate\\certs\\ca.pem"

# Enable only for temporary TLS debugging
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"

npm start
```

This primarily affects:

- Node HTTP and HTTPS requests
- `undici`, `fetch`, and some dependency-driven upstream requests
- internal proxy requests forwarded to upstream services

### Also Capture Electron and Chromium Traffic

If you want both Node-side and renderer-side traffic, add Chromium proxy arguments:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:9090"
$env:HTTPS_PROXY = "http://127.0.0.1:9090"
$env:ALL_PROXY = "http://127.0.0.1:9090"
$env:NO_PROXY = "localhost,127.0.0.1,::1"
$env:NODE_EXTRA_CA_CERTS = "$env:APPDATA\\Proxyman\\certificate\\certs\\ca.pem"
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"

npm start -- --proxy-server="http://127.0.0.1:9090" --proxy-bypass-list="<local>;localhost;127.0.0.1;::1"
```

If your local `npm start` flow does not forward arguments to Electron Forge, use one of these fallback approaches:

- capture only Node and main-process traffic
- wrap the Electron launch in your own PowerShell or VS Code task

## Troubleshooting

### I Can See Requests but HTTPS Bodies Are Empty

Check:

- the Proxyman root certificate is really trusted
- `NODE_EXTRA_CA_CERTS` is set when Node-side traffic needs it
- `NODE_TLS_REJECT_UNAUTHORIZED=0` is only being used as a temporary debugging override
- the target app is not using SSL pinning

Background setup guide:

- [Proxyman Installation and Basic Setup on Windows](./proxyman-install.md)

### I Can See Browser Traffic but Not Node or Main-Process Traffic

Common causes:

- Node is not using system proxy settings
- the HTTP client does not read `HTTP_PROXY`
- only the system proxy was configured, but runtime environment variables were not

### I Cannot See `localhost` Traffic

Common cause:

- loopback traffic is bypassing the proxy

Keep this bypass list in mind when launching Electron:

```plaintext
--proxy-bypass-list="<local>;localhost;127.0.0.1;::1"
```

Adjust it only if your current debugging target requires a different loopback behavior.

### TLS Still Fails After the Certificate Was Installed

Common causes:

- the process started before the certificate was installed and needs a full restart
- `ca.cer` was imported but `ca.pem` was not passed to Node when required
- a corporate proxy, VPN, or security product is changing network behavior
- the target app uses SSL pinning

## Security Notes

Keep local debugging settings out of the repository and out of public issue threads.

- Do not commit your local proxy address, certificate paths, cookies, or OAuth codes.
- Do not leave `NODE_TLS_REJECT_UNAUTHORIZED=0` enabled beyond temporary local debugging.
- Do not post raw tokens, sessions, or authorization headers in public issues.
- Redact logs before sharing them.

## Minimal Workflows

### Official Antigravity Client

1. Complete [Proxyman Installation and Basic Setup on Windows](./proxyman-install.md).
2. Open Proxyman.
3. Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-antigravity-with-proxyman.ps1
```

4. Trigger login, quota, or model-list traffic.

### Antigravity Manager in This Repository

1. Complete [Proxyman Installation and Basic Setup on Windows](./proxyman-install.md).
2. Open PowerShell.
3. Set `HTTP_PROXY`, `HTTPS_PROXY`, and `NODE_EXTRA_CA_CERTS`.
4. Run `npm start`.
5. Filter Proxyman traffic by domains such as:
   - `googleapis.com`
   - `googleusercontent.com`
   - the upstream domain you are debugging

## Related Files

- Setup guide: [Proxyman Installation and Basic Setup on Windows](./proxyman-install.md)
- Official-client launcher: [scripts/start-antigravity-with-proxyman.ps1](../scripts/start-antigravity-with-proxyman.ps1)
