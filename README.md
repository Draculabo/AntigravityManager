<p align="center">
  <img src="docs/assets/logo.png" alt="Antigravity Manager" width="128" height="128" />
</p>

<h1 align="center">Antigravity Manager</h1>

<p align="center">
  <strong>🚀 Professional multi-account manager for Google Gemini & Claude AI</strong>
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/Draculabo/AntigravityManager/actions/workflows/testing.yaml">
    <img src="https://github.com/Draculabo/AntigravityManager/actions/workflows/testing.yaml/badge.svg" alt="Tests" />
  </a>
  <a href="https://github.com/Draculabo/AntigravityManager/actions/workflows/lint.yaml">
    <img src="https://github.com/Draculabo/AntigravityManager/actions/workflows/lint.yaml/badge.svg" alt="Lint" />
  </a>
  <a href="https://github.com/Draculabo/AntigravityManager/releases">
    <img src="https://img.shields.io/github/v/release/Draculabo/AntigravityManager?style=flat-square" alt="Release" />
  </a>
  <a href="https://github.com/Draculabo/AntigravityManager/releases">
    <img src="https://img.shields.io/github/downloads/Draculabo/AntigravityManager/total?style=flat-square&color=blue" alt="Downloads" />
  </a>
  <a href="https://github.com/Draculabo/AntigravityManager/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/Draculabo/AntigravityManager?style=flat-square" alt="License" />
  </a>
  <a href="https://github.com/Draculabo/AntigravityManager/stargazers">
    <img src="https://img.shields.io/github/stars/Draculabo/AntigravityManager?style=flat-square" alt="Stars" />
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-191970?style=for-the-badge&logo=Electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="TailwindCSS" />
</p>

---

## 📖 Table of Contents

- [Why Antigravity Manager?](#-why-antigravity-manager)
- [Features](#-features)
- [Screenshots](#-screenshots)
- [Quick Start](#-quick-start)
- [Tech Stack](#️-tech-stack)
- [Development](#-development)
- [FAQ](#-faq)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Why Antigravity Manager?

When using Antigravity IDE, have you ever encountered these problems?

- 😫 Single account quota runs out quickly, requiring frequent manual switching
- 🔄 Managing multiple Google/Claude accounts is cumbersome
- 📊 Don't know how much quota is left on the current account
- ⏰ Worried about missing quota reset times
- 🔌 Need a reliable local API proxy for development tools

**Antigravity Manager** is here to solve these problems! It's a professional Electron desktop app that helps you:

- ✅ **Unlimited Account Pool** - Add any number of Google Gemini / Claude accounts
- ✅ **Smart Auto-Switching** - Automatically switch to the next available account when quota is low or rate-limited
- ✅ **Real-time Monitoring** - Visualize quota usage for all accounts
- ✅ **Local API Proxy** - Built-in OpenAI/Anthropic compatible proxy server
- ✅ **Secure Encryption** - AES-256-GCM encryption for sensitive data

---

## 🎯 Features

<table>
  <tr>
    <td width="50%">
      <h3>☁️ Cloud Account Pool</h3>
      <ul>
        <li>Add unlimited Google Gemini / Claude accounts via OAuth</li>
        <li>Display avatar, email, status, and last used time</li>
        <li>Real-time status monitoring (Active, Rate Limited, Expired)</li>
      </ul>
    </td>
    <td width="50%">
      <h3>📊 Real-time Quota Monitoring</h3>
      <ul>
        <li>Multi-model support: gemini-pro, claude-3-5-sonnet, etc.</li>
        <li>Visual progress bars with color indicators</li>
        <li>Auto & manual refresh capabilities</li>
      </ul>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🔄 Intelligent Auto-Switching</h3>
      <ul>
        <li>Unlimited pool mode with smart backup selection</li>
        <li>Auto-switch when quota < 5% or rate-limited</li>
        <li>Background monitoring every 5 minutes</li>
      </ul>
    </td>
    <td width="50%">
      <h3>🔐 Security First</h3>
      <ul>
        <li>AES-256-GCM encryption for sensitive data</li>
        <li>OS native credential manager integration</li>
        <li>Auto migration of legacy plaintext data</li>
      </ul>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>💾 Account Backup</h3>
      <ul>
        <li>Capture snapshots of account state</li>
        <li>Fast switching between saved accounts</li>
        <li>View, organize, and delete snapshots</li>
      </ul>
    </td>
    <td width="50%">
      <h3>⚙️ Process Control</h3>
      <ul>
        <li>Auto-detect if Antigravity is running</li>
        <li>Launch via URI protocol or executable</li>
        <li>Graceful close or force kill</li>
      </ul>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🔌 Local API Proxy</h3>
      <ul>
        <li>OpenAI & Anthropic API compatible</li>
        <li>Configurable port and request timeout</li>
        <li>Model mapping (e.g. Claude → Gemini)</li>
      </ul>
    </td>
    <td width="50%">
      <h3>🛠️ Developer Tools</h3>
      <ul>
        <li>Built-in cURL & Python code generation</li>
        <li>Visual service status monitoring</li>
        <li>One-click API Key regeneration</li>
      </ul>
    </td>
  </tr>
</table>

### Additional Features

- **🖥️ System Tray** - Background mode with tray icon and right-click menu
- **🔗 IDE Sync** - Automatically scan and import accounts from IDE's `state.vscdb`
- **📦 Batch Operations** - Batch refresh and delete multiple accounts
- **🌏 Internationalization** - Multi-language support (English / 中文)
- **🎨 Modern UI** - Built with React, TailwindCSS, and Shadcn UI

---

## 📸 Screenshots

<p align="center">
  <img src="docs/assets/screenshot-main.png" alt="Main Interface" width="80%" />
</p>

<p align="center">
  <img src="docs/assets/screenshot-proxy.png" alt="Proxy Interface" width="48%" />
  <img src="docs/assets/screenshot-setting.png" alt="Settings Interface" width="48%" />
</p>


---

## � Quick Start

### Download

Download the latest release for your platform from the [Releases](https://github.com/Draculabo/AntigravityManager/releases) page.

| Platform | Download |
|----------|----------|
| Windows (x64/ARM64) | [.exe installer](https://github.com/Draculabo/AntigravityManager/releases/latest) |
| macOS | [.dmg installer](https://github.com/Draculabo/AntigravityManager/releases/latest) |
| Linux | [.deb / .rpm](https://github.com/Draculabo/AntigravityManager/releases/latest) |

### Build from Source

#### Prerequisites

- Node.js v18 or higher
- npm or yarn

#### Steps

```bash
# Clone the repository
git clone https://github.com/Draculabo/AntigravityManager.git
cd AntigravityManager

# Install dependencies
npm install

# Start development
npm start

# Build for production
npm run make
```

---

## �🛠️ Tech Stack

| Category | Technologies |
|----------|-------------|
| **Core** | [Electron](https://www.electronjs.org/), [React](https://react.dev/), [TypeScript](https://www.typescriptlang.org/) |
| **Build Tool** | [Vite](https://vitejs.dev/) |
| **Styling** | [TailwindCSS](https://tailwindcss.com/), [Shadcn UI](https://ui.shadcn.com/) |
| **State** | [TanStack Query](https://tanstack.com/query/latest), [TanStack Router](https://tanstack.com/router/latest) |
| **Database** | [Better-SQLite3](https://github.com/WiseLibs/better-sqlite3) |
| **Testing** | [Vitest](https://vitest.dev/), [Playwright](https://playwright.dev/) |

---

## � Development

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start the app in development mode |
| `npm run lint` | Run ESLint to check for code issues |
| `npm run format:write` | Format code with Prettier |
| `npm run test:unit` | Run unit tests with Vitest |
| `npm run test:e2e` | Run E2E tests with Playwright |
| `npm run test:all` | Run all tests |
| `npm run type-check` | Run TypeScript type checking |
| `npm run make` | Build production packages |

### Project Structure

```
AntigravityManager/
├── src/
│   ├── main.ts          # Electron main process
│   ├── preload.ts       # Preload script
│   ├── renderer/        # React renderer process
│   ├── ipc/             # IPC communication handlers
│   └── server/          # Built-in server
├── docs/                # Documentation and assets
└── .github/             # GitHub configuration
```

---

## ❓ FAQ

<details>
<summary><b>Q: The app won't start?</b></summary>

Please check:
1. Make sure all dependencies are installed: `npm install`
2. Check if Node.js version is >= 18
3. Try deleting `node_modules` and reinstalling

</details>

<details>
<summary><b>Q: Account login failed?</b></summary>

1. Ensure network connection is working
2. Try clearing app data and logging in again
3. Check if the account is restricted by Google/Claude

</details>

<details>
<summary><b>Q: macOS shows Keychain/Credential error and OAuth cannot be saved?</b></summary>

This is a common macOS security behavior, usually when the app is unsigned or run directly from Downloads.
This is a **temporary workaround** for personal use:

1. Move the app to `/Applications`
2. Run the following commands in Terminal (repeat after every update)

```plaintext
sudo xattr -dr com.apple.quarantine "/Applications/Antigravity Manager 2.app"
codesign --force --deep --sign - "/Applications/Antigravity Manager 2.app"
```

Reopen the app and allow Keychain access if prompted.

</details>

<details>
<summary><b>Q: How to report issues or suggestions?</b></summary>

Please submit issues or suggestions via [GitHub Issues](https://github.com/Draculabo/AntigravityManager/issues).

</details>

---

## 🌟 Star History

<a href="https://github.com/Draculabo/AntigravityManager/stargazers">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Draculabo/AntigravityManager&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Draculabo/AntigravityManager&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Draculabo/AntigravityManager&type=Date" />
  </picture>
</a>

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details.

We follow the [Contributor Covenant](CODE_OF_CONDUCT.md) Code of Conduct.

---

## 📄 License

[CC BY-NC-SA 4.0](LICENSE)

---

## ⚠️ Disclaimer

> [!WARNING]
> **For Educational Purposes Only**
>
> This project is intended solely for educational and research purposes. It is provided "as-is" without any warranty. **Commercial use is strictly prohibited.**
>
> By using this software, you agree that you will not use it for any commercial purposes, and you are solely responsible for ensuring your use complies with all applicable laws and regulations. The authors and contributors are not responsible for any misuse or damages arising from the use of this software.

---

<p align="center">
  If this project helps you, please give it a ⭐ Star!
</p>
