# Feature Module Documentation

This index follows the feature owners listed in [Architecture](../architecture.md#feature-ownership).
It links to guides only where a module has behavior or an acceptance procedure that needs its own
reference. The source module remains the code owner; this directory does not redefine code
boundaries.

| Source module                                                   | Responsibility                                                              | Documentation                                                                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [`account`](../../src/modules/account/)                         | Local account snapshots, backup and restore, and account UI                 | See [architecture](../architecture.md#feature-ownership) and [testing](../testing.md)                                             |
| [`antigravity-runtime`](../../src/modules/antigravity-runtime/) | Client processes, credential stores, launch and account switching           | [Account switching acceptance](antigravity-runtime/account-switch-acceptance.md)                                                  |
| [`app-shell`](../../src/modules/app-shell/)                     | Electron lifecycle, windows, updates and application-wide UI                | [Desktop interface](app-shell/desktop-interface.md); [performance recorder](app-shell/debugging/electron-performance-recorder.md) |
| [`cloud-account`](../../src/modules/cloud-account/)             | OAuth account pool, quota, import, automatic switching and warmup           | [Cloud account module](cloud-account/overview.md)                                                                                 |
| [`config`](../../src/modules/config/)                           | Application and runtime settings                                            | See [architecture](../architecture.md#feature-ownership) and [development](../development.md)                                     |
| [`identity-profile`](../../src/modules/identity-profile/)       | Client identity profiles, storage initialization and dialog behavior        | [Identity profile module](identity-profile/overview.md)                                                                           |
| [`proxy-gateway`](../../src/modules/proxy-gateway/)             | Local API gateway, protocol mapping, model routing and client configuration | [Proxy guides](proxy-gateway/README.md)                                                                                           |
| [`workspace`](../../src/modules/workspace/) | Account-bound project profiles and concurrent IDE instances | [Runtime ownership](workspace/runtime.md) |

## Module contracts and checks

- Cloud accounts: [security](cloud-account/security.md) and [persistence checks](cloud-account/overview.md#focused-persistence-checks).
- Client runtime: [credential and recovery security](antigravity-runtime/security.md),
  [focused testing](antigravity-runtime/testing.md) and [live switching](antigravity-runtime/account-switch-acceptance.md).
- Desktop shell: [presentation/update security](app-shell/security.md) and [renderer/preload testing](app-shell/testing.md).
- Proxy gateway: [storage/input security](proxy-gateway/security.md) and [protocol testing](proxy-gateway/testing.md).

Cross-feature contracts, such as process boundaries, persistence primitives and error ownership,
remain in the root-level [architecture](../architecture.md), [security](../security.md), and
[failure recovery](../error-handling.md) references.
