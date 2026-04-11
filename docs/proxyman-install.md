# Proxyman Installation and Basic Setup on Windows

This guide covers the Proxyman prerequisites for contributors:

1. Install Proxyman for Windows
2. Trust the Proxyman certificate so HTTPS traffic can be decrypted
3. Verify that Proxyman is working before you start debugging Antigravity traffic

If your goal is to debug the installed Antigravity client or this repository's development build, continue with [Proxyman Debugging Guide](./proxyman-debugging.md).

## Scope

This document is intentionally limited to the setup layer. It does not cover Antigravity-specific debugging flows.

Use it when you need to answer:

- How do I install Proxyman on Windows?
- How do I trust the certificate?
- Why can I only see CONNECT requests but not HTTPS bodies?
- How do I verify that Proxyman itself is working?

## Install Proxyman

Official resources:

- Download: [https://proxyman.com/download](https://proxyman.com/download)
- Windows product page: [https://proxyman.com/windows](https://proxyman.com/windows)

Recommended steps:

1. Install the Windows build from the official download page.
2. Launch Proxyman.
3. Confirm that Proxyman is listening on a local proxy port.
4. This guide uses `9090` as the example port. Replace it with your local port if it differs.

## Install and Trust the Certificate

Without the Proxyman root certificate, you will usually only see CONNECT tunnels or TLS handshakes instead of decrypted HTTPS requests.

Official references:

- Windows certificate installation: [https://docs.proxyman.com/proxyman-windows/install-certificate](https://docs.proxyman.com/proxyman-windows/install-certificate)
- SSL troubleshooting: [https://docs.proxyman.com/troubleshooting/get-ssl-error-from-https-request-and-response](https://docs.proxyman.com/troubleshooting/get-ssl-error-from-https-request-and-response)

### Recommended Path: Install Automatically

In Proxyman, run:

```plaintext
Certificate -> Install Certificate on this Windows...
```

Then:

1. Choose `Install & Trust`
2. Approve the administrator prompt

According to the official documentation, Proxyman uses Windows `certutil` to import the root certificate into the trusted store.

### Prepare a PEM File for Node and Electron

Some Node.js and Electron traffic needs more than system trust. You may also need to point the runtime at the PEM file:

```plaintext
%APPDATA%\Proxyman\certificate\certs\ca.pem
```

If you only see `ca.cer` and not `ca.pem`, confirm that Proxyman has generated the PEM variant before moving on.

## Verify That Proxyman Works

Do this before trying to debug any application-specific flow.

### Verify Browser Traffic

1. Open Proxyman.
2. Visit any HTTPS page in a browser, for example:

```plaintext
https://httpbin.org/get
```

3. Confirm that the request and response appear in Proxyman.

### If You Cannot See Any Traffic

Check these first:

- Proxyman is actually listening on the expected port
- Windows proxy settings are pointing to Proxyman
- A VPN, endpoint security agent, or antivirus is not taking over proxy behavior
- The certificate is trusted

If localhost traffic is missing, see:

- [https://docs.proxyman.com/troubleshooting/couldnt-see-any-request-from-localhost-server](https://docs.proxyman.com/troubleshooting/couldnt-see-any-request-from-localhost-server)

The official page includes macOS-specific examples, but the localhost bypass concept is still relevant on Windows.

## Basic Troubleshooting

### HTTPS Bodies Are Missing

Common causes:

- The Proxyman root certificate is not actually trusted
- The target process was already running before the certificate was installed
- The application uses SSL pinning

### Certificate Is Installed but TLS Still Fails

Common causes:

- You imported `ca.cer` but did not provide `ca.pem` to the runtime when needed
- A corporate proxy, VPN, or security product is overriding the network path
- The target application uses SSL pinning

### Localhost Traffic Is Missing

Common cause:

- Local loopback traffic is bypassing the proxy

Official reference:

- [https://docs.proxyman.com/troubleshooting/couldnt-see-any-request-from-localhost-server](https://docs.proxyman.com/troubleshooting/couldnt-see-any-request-from-localhost-server)

## Next Step

Once Proxyman is installed, trusted, and verified, continue with:

- [Proxyman Debugging Guide](./proxyman-debugging.md)

## References

- Proxyman download page: [https://proxyman.com/download](https://proxyman.com/download)
- Proxyman Windows page: [https://proxyman.com/windows](https://proxyman.com/windows)
- Proxyman Windows certificate guide: [https://docs.proxyman.com/proxyman-windows/install-certificate](https://docs.proxyman.com/proxyman-windows/install-certificate)
- Proxyman localhost troubleshooting: [https://docs.proxyman.com/troubleshooting/couldnt-see-any-request-from-localhost-server](https://docs.proxyman.com/troubleshooting/couldnt-see-any-request-from-localhost-server)
- Proxyman SSL troubleshooting: [https://docs.proxyman.com/troubleshooting/get-ssl-error-from-https-request-and-response](https://docs.proxyman.com/troubleshooting/get-ssl-error-from-https-request-and-response)
