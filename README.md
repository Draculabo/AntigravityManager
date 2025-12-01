# Antigravity Manager

Antigravity Manager is a professional Electron-based application designed to manage multiple cloud AI accounts (Google Gemini / Claude) for the Antigravity application. It provides seamless account switching, real-time quota monitoring, intelligent auto-switching, and comprehensive backup management.

## Features

### Core Features

- **Cloud Account Pool Management**
  - Add unlimited Google Gemini / Claude accounts via OAuth authorization
  - Display account details: avatar, email, status, and last used time
  - Real-time account status monitoring (Active, Rate Limited, Expired)
  - Delete accounts from local database

- **Real-time Quota Monitoring**
  - Multi-model support: Monitor quotas for `gemini-pro`, `claude-3-5-sonnet`, etc.
  - Visual display with progress bars and color indicators (green/yellow/red)
  - Auto & manual refresh capabilities

- **Intelligent Auto-Switching**
  - Unlimited pool mode: Automatically find and switch to the best backup account when current quota is low (<5%) or rate-limited
  - Background monitoring: Built-in `CloudMonitorService` polls all accounts every 5 minutes
  - Global toggle: Enable/disable via one-click in the UI

- **One-Click Account Switching**
  - Inject tokens directly into IDE's `state.vscdb` database using Protobuf parsing
  - Graceful process restart to apply new credentials

### Account Backup

- **Backup**: Capture snapshots of your current account state
- **Restore**: Fast and easy switching between multiple saved accounts
- **Management**: View, organize, and delete saved account snapshots

### Process Control

- Automatically detect if Antigravity is running
- Launch Antigravity via URI protocol or executable path
- Gracefully close or force kill the Antigravity process

### System Integration

- **System Tray**: Background mode with tray icon and right-click menu
- **IDE Sync**: Automatically scan and import accounts from IDE's `state.vscdb`
- **Batch Operations**: Batch refresh and delete multiple accounts

### Security Hardening

- **Key Management**: Uses OS native credential manager (Windows Credential Manager / macOS Keychain) via `keytar` to securely store Master Key (AES-256)
- **Data Encryption**: All sensitive data (`token_json`, `quota_json`) encrypted with `AES-256-GCM` before storage
- **Auto Migration**: Automatic detection and migration of legacy plaintext data on startup

### Other Features

- **Internationalization**: Multi-language support (English / 中文)
- **Modern UI**: Built with React, TailwindCSS, and Shadcn UI for a clean and responsive experience

## Tech Stack

- **Core**: [Electron](https://www.electronjs.org/), [React](https://react.dev/), [TypeScript](https://www.typescriptlang.org/)
- **Build Tool**: [Vite](https://vitejs.dev/)
- **Styling**: [TailwindCSS](https://tailwindcss.com/)
- **State Management**: [TanStack Query](https://tanstack.com/query/latest)
- **Routing**: [TanStack Router](https://tanstack.com/router/latest)
- **Database**: [Better-SQLite3](https://github.com/WiseLibs/better-sqlite3)
- **Testing**: [Vitest](https://vitest.dev/), [Playwright](https://playwright.dev/)

## Getting Started

### Prerequisites

- Node.js (v18 or higher recommended)
- npm or yarn

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd AntigravityManager
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Development

To start the application in development mode:

```bash
npm start
```

This will launch the Electron app with hot-reloading enabled.

### Building

To create a distributable package for your platform:

```bash
npm run make
```

The output will be available in the `out` directory.

### Testing

- Run unit tests: `npm run test:unit`
- Run E2E tests: `npm run test:e2e`
- Run all tests: `npm run test:all`

## License

[MIT](LICENSE)
