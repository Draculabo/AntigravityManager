<a name="readme-top"></a>

# Changelog

## [0.5.0](https://github.com/Draculabo/AntigravityManager/compare/v0.4.0...v0.5.0) (2026-01-30)

### ✨ Features

- **i18n:** add Russian localization ([#48](https://github.com/Draculabo/AntigravityManager/issues/48)) ([63956c9](https://github.com/Draculabo/AntigravityManager/commit/63956c9c2d60f829a998237abe6ade675fdb01ed))
- Implement collapsible sidebar and refined status bar UI ([#45](https://github.com/Draculabo/AntigravityManager/issues/45)) ([1265d04](https://github.com/Draculabo/AntigravityManager/commit/1265d044f69e52fba7da72fde6c47a0b85c58232))
- sentry integration ([#51](https://github.com/Draculabo/AntigravityManager/issues/51)) ([a785640](https://github.com/Draculabo/AntigravityManager/commit/a785640d7a51b65a6852383401bd7c284b716975))

## [0.4.0](https://github.com/Draculabo/AntigravityManager/compare/v0.3.5...v0.4.0) (2026-01-28)

### ✨ Features

- add system autostart and single-instance support ([ea51253](https://github.com/Draculabo/AntigravityManager/commit/ea51253d589abd537682344d3bdb684b8fc9a511))
- implement smart foreground quota refresh with debounce ([dd9e84a](https://github.com/Draculabo/AntigravityManager/commit/dd9e84a0dbefad6066193b6bd468689a755a02e3))

### 🐛 Bug Fixes

- stub nestjs optional modules for packaging ([f0eb7c6](https://github.com/Draculabo/AntigravityManager/commit/f0eb7c6b619a3ea9ea203d66f5dbce731d731e3c))

## [0.3.5](https://github.com/Draculabo/AntigravityManager/compare/v0.3.4...v0.3.5) (2026-01-26)

### 🐛 Bug Fixes

- "Check Quota Now" button not refreshing UI after polling ([#42](https://github.com/Draculabo/AntigravityManager/issues/42)) ([e959ee3](https://github.com/Draculabo/AntigravityManager/commit/e959ee346e7c26a8a4c5b7deefa5bd2452153f9d))

### 📝 Documentation

- remove beta download links from README ([5a21680](https://github.com/Draculabo/AntigravityManager/commit/5a2168030eac4ddeffa1c3b002b2de48b6a11a8f))

## [0.3.4](https://github.com/Draculabo/AntigravityManager/compare/v0.3.3...v0.3.4) (2026-01-26)

### 🐛 Bug Fixes

- **security:** add safeStorage fallback for production builds ([#38](https://github.com/Draculabo/AntigravityManager/issues/38)) ([#43](https://github.com/Draculabo/AntigravityManager/issues/43)) ([0208058](https://github.com/Draculabo/AntigravityManager/commit/02080588b764ed88a5831152a3a1249f1d077d29))

### 📝 Documentation

- update beta release link ([d5ee08d](https://github.com/Draculabo/AntigravityManager/commit/d5ee08d5a06a915a8b82f680b38e2f532105498c))

## [0.3.4-beta.1](https://github.com/Draculabo/AntigravityManager/compare/v0.3.3...v0.3.4-beta.1) (2026-01-25)

### 🐛 Bug Fixes

- **security:** add safeStorage fallback for production builds ([#38](https://github.com/Draculabo/AntigravityManager/issues/38)) ([92dc2f6](https://github.com/Draculabo/AntigravityManager/commit/92dc2f6f2169eb1a32950694387f2333ea2de682))

## [0.3.3](https://github.com/Draculabo/AntigravityManager/compare/v0.3.2...v0.3.3) (2026-01-25)

### 🐛 Bug Fixes

- accept lowercase antigravity in process detection ([0d4e2ab](https://github.com/Draculabo/AntigravityManager/commit/0d4e2ab21f37704e09ef1a67c181c48b42df1180))

### 📝 Documentation

- add beta download link to readme ([f15bb48](https://github.com/Draculabo/AntigravityManager/commit/f15bb48fdda10fda3c2382941ee0ce51204f750a))
- clean up changelog duplicate ([22265e1](https://github.com/Draculabo/AntigravityManager/commit/22265e153c9d394229aa48afdc5948044b74e842))

## [0.3.2](https://github.com/Draculabo/AntigravityManager/compare/v0.3.1...v0.3.2) (2026-01-25)

### 🐛 Bug Fixes

- handle keychain hint and suppress pgrep spam ([bd3d41a](https://github.com/Draculabo/AntigravityManager/commit/bd3d41aed17bafe9d684c5c421bad8b90afa19a8))

### 📝 Documentation

- add macOS self-signing workaround for Keychain issues ([01e3f8f](https://github.com/Draculabo/AntigravityManager/commit/01e3f8f8fd6dacc5eed214ed4b505d6d85f4bcff))

### 🔧 Continuous Integration

- setup semantic release configuration and github actions workflow ([d2945a6](https://github.com/Draculabo/AntigravityManager/commit/d2945a6e8a14d75f577716183cdff093443d9636))
- trigger publish on release published event ([6a07bc0](https://github.com/Draculabo/AntigravityManager/commit/6a07bc0a10a5ad802777e007cfd7390852119b15))

## [0.3.1] - 2026-01-25

### Bug Fixes

- Fixed startup race condition causing cloud accounts verify failure ([f0718db])
- Enabled WAL mode and force initialization on startup to resolve process resource contention ([1bce5d3])

## [0.3.0] - 2026-01-23

### New Features

- Verify Google OAuth code automatically after receipt
- Add button to open logs folder
- Add expiration warning for Google OAuth authentication

### Bug Fixes

- Fixed `state.vscdb` path on Linux to include `User/globalStorage` subdirectory (Fixed [#26](https://github.com/Draculabo/AntigravityManager/issues/26))
- Improved process detection on macOS/Linux using `find-process` to reliably identify the main application and exclude helper processes (Fixed [#27](https://github.com/Draculabo/AntigravityManager/issues/27))
- Fixed keychain access error on macOS Apple Silicon (M1/M2/M3) by adding arm64 build to CI

### Maintenance

- Add VS Code settings for auto-formatting and ESLint

## [0.2.2] - 2026-01-19

### Bug Fixes

- Fixed tray icon not appearing in production builds on Windows
  - Used `extraResource` config to properly copy assets outside of ASAR package
  - Added debug logging for tray icon path resolution

## [0.2.1] - 2026-01-19

### Bug Fixes

- Fixed process detection to be case-insensitive on Linux/macOS (`pgrep -xi`) ([#24](https://github.com/Draculabo/AntigravityManager/pull/24)) - Thanks [@Olbrasoft](https://github.com/Olbrasoft)!
- Fixed manager exclusion logic to prevent accidental self-termination ([#24](https://github.com/Draculabo/AntigravityManager/pull/24))
- Fixed zombie tray icons on application restart/hot reload ([#24](https://github.com/Draculabo/AntigravityManager/pull/24))

### Maintenance

- Applied Prettier formatting to entire codebase (68 files)
- Added node globals to ESLint configuration

## [0.2.0] - 2026-01-16

### New Features

- Enhanced cloudHandler to inject minimal auth state when database entry is missing, improving onboarding reliability.
- Implemented stability fixes and enhanced error handling across the application.

### Improvements

- Upgraded Electron from 32.3.3 to 37.3.1 for improved performance and security.
- Conditionally include plugins based on start command in forge.config.ts for better build flexibility.

### Bug Fixes

- Fixed "Converting circular structure to JSON" error.

### Documentation

- Added curly brace constraints for conditional statements.
- Fixed incorrect reference documentation name.

## [0.1.1] - 2026-01-11

### Bug Fixes

- Fix Antigravity visibility issue on account switch. (Fixed [#19](https://github.com/Draculabo/AntigravityManager/issues/19))

## [0.1.0] - 2026-01-10

### New Features

- LAN Connection Support: Users can now connect via Local Area Network (LAN) for improved flexibility and internal environment support.
- Antigravity Integration: Added native support and adaptation for Antigravity, enhancing overall compatibility.
- Local API Proxy: Built-in OpenAI/Anthropic compatible proxy server.

### Bug Fixes

- Reverse Proxy Issue: Resolved a critical error occurring during reverse proxy configurations. (Fixed [#11](https://github.com/Draculabo/AntigravityManager/issues/11))

## [0.0.1] - 2025-12-22

### Added

- Initial release of Antigravity Manager
- Multi-account management for Google Gemini and Claude
- Real-time quota monitoring
- Intelligent auto-switching capabilities
- Secure credential storage (AES-256-GCM)
- IDE synchronization
- Dark mode support
- System tray integration
