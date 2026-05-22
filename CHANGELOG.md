<a name="readme-top"></a>

# Changelog

## [0.13.0](https://github.com/Draculabo/AntigravityManager/compare/v0.12.0...v0.13.0) (2026-05-22)

### ✨ Features

* add Antigravity app target settings ([b3dbaad](https://github.com/Draculabo/AntigravityManager/commit/b3dbaadac3b7efdc5bb6cf8bfca4e8bedf8cd4d8))
* **i18n:** add Turkish language support ([#175](https://github.com/Draculabo/AntigravityManager/issues/175)) ([836dfbf](https://github.com/Draculabo/AntigravityManager/commit/836dfbf67bcec92cfd5e9efc0ed48ac62b10cebe))
* support Antigravity credential-store tokens ([4a3e2d9](https://github.com/Draculabo/AntigravityManager/commit/4a3e2d9034c1bd07cbd5af8c974c85c2d577d056))
* switch accounts by Antigravity target ([124b8c0](https://github.com/Draculabo/AntigravityManager/commit/124b8c031dcdc01d62fb5aa49cbaaf07e7c4dfe6))
* update Antigravity Manager to support Antigravity IDE (2.0) ([#179](https://github.com/Draculabo/AntigravityManager/issues/179)) ([5a89e3d](https://github.com/Draculabo/AntigravityManager/commit/5a89e3d92b0f85ae50259c2d0b987d94254dcb9e))

### 🐛 Bug Fixes

* **i18n:** rename Antigravity switch action label ([55d3a8e](https://github.com/Draculabo/AntigravityManager/commit/55d3a8ef77e95b622be3fd3af21c4b4382cb6e19))

### ♻️ Code Refactoring

* move cloud account code into feature module ([d854df3](https://github.com/Draculabo/AntigravityManager/commit/d854df3317c0724527feb1b3d83e7af201b4e21d))

### ✅ Tests

* cover Antigravity target workflows ([18fdca6](https://github.com/Draculabo/AntigravityManager/commit/18fdca659b9349f8e8728177f0685e7ceb916b12))

## [0.12.0](https://github.com/Draculabo/AntigravityManager/compare/v0.11.1...v0.12.0) (2026-05-07)

### ✨ Features

* increase the request timeout period ([8a0637f](https://github.com/Draculabo/AntigravityManager/commit/8a0637f925073ee9354dbea1ae0d1dc433b2ecad))

### 🐛 Bug Fixes

* **cloud:** preserve Google token metadata during sync ([b9e932d](https://github.com/Draculabo/AntigravityManager/commit/b9e932df61bf28c235888e9c96ff20ad8135316a))
* **proxy:** align upstream retry and rate-limit handling ([dbf5345](https://github.com/Draculabo/AntigravityManager/commit/dbf53454c55b5dfc810286e90953c826e07ddbce))
* refresh Google token before account switch injection ([#168](https://github.com/Draculabo/AntigravityManager/issues/168)) ([03a1307](https://github.com/Draculabo/AntigravityManager/commit/03a13077d11191212efe2372b65196127a4d9d02))

### ♻️ Code Refactoring

* **antigravity:** clarify request and quota mapping ([0758b1d](https://github.com/Draculabo/AntigravityManager/commit/0758b1d1326413ec6cc1b9382fb4b66295631e1b))

### ✅ Tests

* remove obsolete core feature suite ([abcee97](https://github.com/Draculabo/AntigravityManager/commit/abcee97c372aa322fd0628822bf02551727253ef))

### 🔧 Continuous Integration

* align publish workflow with Node 22 and add npm install retry ([158d2f3](https://github.com/Draculabo/AntigravityManager/commit/158d2f30ccf05803f380966982cadd2b58f68a17))

## [0.11.1](https://github.com/Draculabo/AntigravityManager/compare/v0.11.0...v0.11.1) (2026-04-18)

### 🐛 Bug Fixes

* add unit label to AI credit display ([6577f1c](https://github.com/Draculabo/AntigravityManager/commit/6577f1c51fd155004b81f6171eb5feffa2448128))
* remaining localization gaps ([#156](https://github.com/Draculabo/AntigravityManager/issues/156)) ([7093c98](https://github.com/Draculabo/AntigravityManager/commit/7093c982ba790380cda7d1e8a53891970df6b3cf))
* remove AI credit refresh time scraping ([3e1e10b](https://github.com/Draculabo/AntigravityManager/commit/3e1e10b2a580ebf5a64b9a8982bd812a6a1f2924))

### 📝 Documentation

* **repo:** update project docs ([440a934](https://github.com/Draculabo/AntigravityManager/commit/440a9342800f244287c758b1a77a05fac9096df7))

### ♻️ Code Refactoring

* **ipc:** migrate renderer IPC client to official oRPC client ([d0c282d](https://github.com/Draculabo/AntigravityManager/commit/d0c282dffff24bb74a81cfa523f2f72f949bf8f9))
* standardize runtime guard patterns with lodash-es ([#154](https://github.com/Draculabo/AntigravityManager/issues/154)) ([bc35b96](https://github.com/Draculabo/AntigravityManager/commit/bc35b96b5d2d873cf0f187a57de695aedc32108f))

## [0.11.0](https://github.com/Draculabo/AntigravityManager/compare/v0.10.0...v0.11.0) (2026-04-11)

### ✨ Features

* account management overhaul + 7 issue resolutions ([#147](https://github.com/Draculabo/AntigravityManager/issues/147)) ([ed0dd81](https://github.com/Draculabo/AntigravityManager/commit/ed0dd811a8958928a2702839db07444e89f9fdb2)), closes [#79](https://github.com/Draculabo/AntigravityManager/issues/79) [#126](https://github.com/Draculabo/AntigravityManager/issues/126) [#99](https://github.com/Draculabo/AntigravityManager/issues/99) [#145](https://github.com/Draculabo/AntigravityManager/issues/145) [#134](https://github.com/Draculabo/AntigravityManager/issues/134) [#53](https://github.com/Draculabo/AntigravityManager/issues/53) [#117](https://github.com/Draculabo/AntigravityManager/issues/117)
* **antigravity:** add model specs and update mapping logic ([0a60c0e](https://github.com/Draculabo/AntigravityManager/commit/0a60c0eafa698202722be9c283cb52831e2e0179))
* **cloud-oauth:** support selectable google oauth clients ([bcdf2a6](https://github.com/Draculabo/AntigravityManager/commit/bcdf2a6c24fc992d32b4ae883f2a34c8e64969e3))
* **cloud-status:** classify blocked accounts and surface validation state ([388fbcb](https://github.com/Draculabo/AntigravityManager/commit/388fbcb2a9522285eb0bb4a541b48cd3e1049470))
* **cloud-sync:** persist project and status metadata for synced accounts ([385036d](https://github.com/Draculabo/AntigravityManager/commit/385036d577495caeebf95301542811b08c9f333e))
* **protobuf:** add unified state helpers for oauth payloads ([f970ccb](https://github.com/Draculabo/AntigravityManager/commit/f970ccb2ed1f3a3e9de09221895f0b650c1115b9))
* **proxy:** add upstream error and rate-limit tracking support ([20fffff](https://github.com/Draculabo/AntigravityManager/commit/20fffff29c47d1147e9b429884d9e8b613e7da6f))
* **proxy:** improve parity, rate limiting, and token scheduling ([5401e40](https://github.com/Draculabo/AntigravityManager/commit/5401e40943824d54bc95971229a83934e55ad88f))
* **proxy:** improve quota fallback and proxy parity handling ([4fa0a3c](https://github.com/Draculabo/AntigravityManager/commit/4fa0a3c63dd4b973d0d07feb7351831ad827176d))
* **ui:** update cloud account and provider visibility experience ([c95f494](https://github.com/Draculabo/AntigravityManager/commit/c95f494569b49ff1fae871970764c9f0a3fbda59))

### 🐛 Bug Fixes

* **cloud:** add missing oauth action bindings and validation status helper ([87c17a1](https://github.com/Draculabo/AntigravityManager/commit/87c17a1ed0856572f0f8c46ede923b563b726108))
* **cloud:** fetch AI credits on startup with endpoint fallback and preserve cached credits ([61716bb](https://github.com/Draculabo/AntigravityManager/commit/61716bb51259c0a5899b8659aa864c5772b75cbb))
* **linux:** dynamic executable path detection ([#121](https://github.com/Draculabo/AntigravityManager/issues/121)) ([30e38dc](https://github.com/Draculabo/AntigravityManager/commit/30e38dcb8b9329b68601c9df896fd815ccadc1ec))
* **linux:** harden account-switch relaunch against GPU process crashes ([2c1755e](https://github.com/Draculabo/AntigravityManager/commit/2c1755e578ac91962e813a141ec7d3df6fa61a74))

### 📝 Documentation

* **proxyman:** add setup and debugging guides and link them from readmes ([3100db9](https://github.com/Draculabo/AntigravityManager/commit/3100db93ed92f9f8ef19aceae49a699768e20ca9))

### ✅ Tests

* **proxy:**  refine signature test text ([50a325b](https://github.com/Draculabo/AntigravityManager/commit/50a325be113ef59dd9d0144b84d64f9eb40ea67a))

## [0.10.0](https://github.com/Draculabo/AntigravityManager/compare/v0.9.2...v0.10.0) (2026-02-19)

### ✨ Features

* Add powerful CLI for account management ([#115](https://github.com/Draculabo/AntigravityManager/issues/115)) ([b949764](https://github.com/Draculabo/AntigravityManager/commit/b9497648c6a7f50dd9b05a7f3d54ac95fa373349))
* Implement provider groupings with account calculator and compre… ([#113](https://github.com/Draculabo/AntigravityManager/issues/113)) ([1e59a1c](https://github.com/Draculabo/AntigravityManager/commit/1e59a1c901d5feedb1089015060fc8c31b614d4d))

### 🐛 Bug Fixes

* refactor layout containers for proxy and settings pages to ensure full height and unified scrolling ([#102](https://github.com/Draculabo/AntigravityManager/issues/102)) ([caaaaf5](https://github.com/Draculabo/AntigravityManager/commit/caaaaf571864aeb2bd68dc271972fd197c999bd1))
* **statusbar:** reduce process polling from 2s to 10s to prevent heap corruption crash ([#110](https://github.com/Draculabo/AntigravityManager/issues/110)) ([118fad5](https://github.com/Draculabo/AntigravityManager/commit/118fad567eeaac4e173b97d3eeb84e1f3edd4556))

## [0.9.2](https://github.com/Draculabo/AntigravityManager/compare/v0.9.1...v0.9.2) (2026-02-11)

### 🐛 Bug Fixes

* project id fallback and stream error regression ([#94](https://github.com/Draculabo/AntigravityManager/issues/94)) ([caf9d58](https://github.com/Draculabo/AntigravityManager/commit/caf9d5849ac86f4c83cb7b33804b873e0c2ff545))

## [0.9.1](https://github.com/Draculabo/AntigravityManager/compare/v0.9.0...v0.9.1) (2026-02-11)

### 🐛 Bug Fixes

* project id forwarding regression ([#93](https://github.com/Draculabo/AntigravityManager/issues/93)) ([ab78d93](https://github.com/Draculabo/AntigravityManager/commit/ab78d9325213623067b5bd867b35464cd4eefd73))

## [0.9.0](https://github.com/Draculabo/AntigravityManager/compare/v0.8.0...v0.9.0) (2026-02-10)

### ✨ Features

* add vercel and ui skills ([#86](https://github.com/Draculabo/AntigravityManager/issues/86)) ([0f7a629](https://github.com/Draculabo/AntigravityManager/commit/0f7a629a4794b5e340371c8d6614c36d14b5ef43))
* global error fallback and e2e ([#91](https://github.com/Draculabo/AntigravityManager/issues/91)) ([b89dd2c](https://github.com/Draculabo/AntigravityManager/commit/b89dd2c3bbb8ae1617cec511960c934c260abc7c))
* implement protocol parity and harden upstream handling ([#88](https://github.com/Draculabo/AntigravityManager/issues/88)) ([13f10fe](https://github.com/Draculabo/AntigravityManager/commit/13f10fe32f73306470a50b0284c8026117b65695))

### 🐛 Bug Fixes

* prevent page crash on 500 and add toast-based fallback ([#90](https://github.com/Draculabo/AntigravityManager/issues/90)) ([bcca5ec](https://github.com/Draculabo/AntigravityManager/commit/bcca5ec9351cef6b1cda708777459055a0bc1a0c))
* prevent sensitive data logging ([#70](https://github.com/Draculabo/AntigravityManager/issues/70)) ([5155e37](https://github.com/Draculabo/AntigravityManager/commit/5155e37fd1ceb4bc72f121fbc9ca53e6b12ce646))

### 📝 Documentation

* upgrade openspec workflow ([#85](https://github.com/Draculabo/AntigravityManager/issues/85)) ([e4584d0](https://github.com/Draculabo/AntigravityManager/commit/e4584d0bc4627054cc2d2b07f998e9f61614e88c))

### 🔧 Continuous Integration

* fix publish workflow release tag resolution ([#82](https://github.com/Draculabo/AntigravityManager/issues/82)) ([5613709](https://github.com/Draculabo/AntigravityManager/commit/56137092beab315843d401e17a3edd456d38ba87))
* remove darwin universal build from publish workflow ([#81](https://github.com/Draculabo/AntigravityManager/issues/81)) ([5b93ca8](https://github.com/Draculabo/AntigravityManager/commit/5b93ca889108ac354e6c9a84f01149f4653ed7c6))
* split publish into build and gated release with dry-run ([#80](https://github.com/Draculabo/AntigravityManager/issues/80)) ([3eaf927](https://github.com/Draculabo/AntigravityManager/commit/3eaf9278ae2ef0103efaeed7a0ebdc77a4961025))

## [0.8.0](https://github.com/Draculabo/AntigravityManager/compare/v0.7.0...v0.8.0) (2026-02-07)

### ✨ Features

* complete account-bound profile switching and hardening ([#78](https://github.com/Draculabo/AntigravityManager/issues/78)) ([a93c6d0](https://github.com/Draculabo/AntigravityManager/commit/a93c6d0cea5b9904a30234faffe767505f753373))

### 🐛 Bug Fixes

* **ci:** increase Node heap for publish step to prevent macOS OOM ([#76](https://github.com/Draculabo/AntigravityManager/issues/76)) ([ee64179](https://github.com/Draculabo/AntigravityManager/commit/ee641799c27425ceb6d2d6d00a132881bedb1f04))
* **ci:** make WiX Toolset setup resilient on Windows runners ([#73](https://github.com/Draculabo/AntigravityManager/issues/73)) ([5fe434f](https://github.com/Draculabo/AntigravityManager/commit/5fe434f7050cb8975d65502baeb03b1747e00611))

### 📝 Documentation

* **openspec:** backfill missing proposals ([287e848](https://github.com/Draculabo/AntigravityManager/commit/287e848b3291d2ee43b173802b87491c2a90930d))

## [0.7.0](https://github.com/Draculabo/AntigravityManager/compare/v0.6.0...v0.7.0) (2026-02-06)

### ✨ Features

* add multi-arch release artifacts and MSI packaging ([#65](https://github.com/Draculabo/AntigravityManager/issues/65)) ([f572ae4](https://github.com/Draculabo/AntigravityManager/commit/f572ae4652937efb25ab66defcfa55ddf65ac484))

### 🐛 Bug Fixes

* restore account switching on Antigravity 1.16.5 and migrate db sync to drizzle ([#69](https://github.com/Draculabo/AntigravityManager/issues/69)) ([ed94abf](https://github.com/Draculabo/AntigravityManager/commit/ed94abf0d6e90c0a1bf9c76f1ec3fdea091f6c4b))

### 📝 Documentation

* translate repository documentation to English ([#72](https://github.com/Draculabo/AntigravityManager/issues/72)) ([18389b9](https://github.com/Draculabo/AntigravityManager/commit/18389b975392f63441ede8369f13f6ef068214ab))

### ♻️ Code Refactoring

* migrate to winston and enable daily rotated app logs ([#71](https://github.com/Draculabo/AntigravityManager/issues/71)) ([2ae2216](https://github.com/Draculabo/AntigravityManager/commit/2ae2216f1ed3fa503ffd87a14cafd3921077a5c4))

## [0.6.0](https://github.com/Draculabo/AntigravityManager/compare/v0.5.0...v0.6.0) (2026-02-04)

### ✨ Features

*  add cloud reset time UI ([#56](https://github.com/Draculabo/AntigravityManager/issues/56)) ([f6f8069](https://github.com/Draculabo/AntigravityManager/commit/f6f8069ce4673ae7027c6ba248daa18c8b602218))
* windows install guidance ([#63](https://github.com/Draculabo/AntigravityManager/issues/63)) ([ce71470](https://github.com/Draculabo/AntigravityManager/commit/ce7147025d37648a82f6f6b300502ef4462bfde6))

### 🐛 Bug Fixes

* correct Windows install notice path ([5bda4b1](https://github.com/Draculabo/AntigravityManager/commit/5bda4b19dfc9ce64735cd39600d41a5deefc26ee))
* **proxy:** route Claude Code CLI requests on /v1/chat/completions to Anthropic handler ([#61](https://github.com/Draculabo/AntigravityManager/issues/61)) ([476d297](https://github.com/Draculabo/AntigravityManager/commit/476d297e4b2dd3015f7ebcbb915b643730816dc6))

## [0.5.0](https://github.com/Draculabo/AntigravityManager/compare/v0.4.0...v0.5.0) (2026-01-30)

### ✨ Features

* **i18n:** add Russian localization ([#48](https://github.com/Draculabo/AntigravityManager/issues/48)) ([63956c9](https://github.com/Draculabo/AntigravityManager/commit/63956c9c2d60f829a998237abe6ade675fdb01ed))
* Implement collapsible sidebar and refined status bar UI ([#45](https://github.com/Draculabo/AntigravityManager/issues/45)) ([1265d04](https://github.com/Draculabo/AntigravityManager/commit/1265d044f69e52fba7da72fde6c47a0b85c58232))
* sentry integration ([#51](https://github.com/Draculabo/AntigravityManager/issues/51)) ([a785640](https://github.com/Draculabo/AntigravityManager/commit/a785640d7a51b65a6852383401bd7c284b716975))

## [0.4.0](https://github.com/Draculabo/AntigravityManager/compare/v0.3.5...v0.4.0) (2026-01-28)

### ✨ Features

* add system autostart and single-instance support ([ea51253](https://github.com/Draculabo/AntigravityManager/commit/ea51253d589abd537682344d3bdb684b8fc9a511))
* implement smart foreground quota refresh with debounce ([dd9e84a](https://github.com/Draculabo/AntigravityManager/commit/dd9e84a0dbefad6066193b6bd468689a755a02e3))

### 🐛 Bug Fixes

* stub nestjs optional modules for packaging ([f0eb7c6](https://github.com/Draculabo/AntigravityManager/commit/f0eb7c6b619a3ea9ea203d66f5dbce731d731e3c))

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
