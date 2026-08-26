# Agent Note: credential, gateway, and diagnostic-data boundary hardening

Status: proposed

## Problem

Several platform and diagnostic paths can disclose or mishandle sensitive data. Ambiguous WSL CLI token targets can select another user's file, macOS Keychain writes can expose the secret as process arguments, an open gateway can be reachable on the LAN, and diagnostic captures or observability events can retain credentials or local user paths.

## Proposal

The application will skip ambiguous WSL token targets, pass macOS Keychain values through stdin while retaining atomic updates, bind an unauthenticated gateway to loopback, and redact sensitive query parameters, proxy userinfo, and local-user path segments before diagnostic data is persisted or sent to Sentry.

## Alternatives considered

- Select the first matching WSL path: rejected because path order is not authorization.
- Keep the Keychain value in command arguments: rejected because local process inspection is a practical disclosure path.
- Leave an unauthenticated gateway on all interfaces: rejected because LAN reachability is unnecessary by default.
- Rely on operators to avoid sensitive URLs and paths in diagnostics: rejected because failures are precisely when automated capture occurs.

## Acceptance criteria

- Ambiguous WSL targets are skipped without blocking local CLI synchronization.
- macOS Keychain writes do not include credential data in process arguments and do not delete the old entry before update.
- A gateway without an API key listens only on loopback.
- Capture documents, log strings, and Sentry events redact the covered sensitive values.
- Focused credential, gateway, capture, masking, and Sentry tests pass.

## Risks

The macOS `security` command and Keychain behavior require macOS validation; mocked tests cannot prove native behavior. Redaction is intentionally conservative and can reduce debugging detail. New credential-bearing URL or path formats may require additions to the central patterns.
