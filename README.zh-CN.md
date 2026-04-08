<p align="center">
  <img src="docs/assets/logo.png" alt="Antigravity Manager" width="128" height="128" />
</p>

<h1 align="center">Antigravity Manager</h1>

<p align="center">
  <strong>🚀 专业的 Google Gemini & Claude AI 多账号管理器</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
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

## 📖 目录

- [为什么选择 Antigravity Manager？](#-为什么选择-antigravity-manager)
- [功能特性](#-功能特性)
- [截图预览](#-截图预览)
- [快速开始](#-快速开始)
- [技术栈](#️-技术栈)
- [开发指南](#-开发指南)
- [常见问题](#-常见问题)
- [贡献指南](#-贡献指南)
- [许可证](#-许可证)

---

## ✨ 为什么选择 Antigravity Manager？

在使用 Antigravity IDE 时，你是否遇到过这些问题？

- 😫 单个账号额度很快用完，需要频繁手动切换
- 🔄 管理多个 Google/Claude 账号非常麻烦
- 📊 不知道当前账号还剩多少额度
- ⏰ 担心错过额度重置时间
- 🔌 需要可靠的本地 API 代理用于开发工具

**Antigravity Manager** 就是为解决这些问题而生的！它是一个专业的 Electron 桌面应用，帮助你：

- ✅ **无限账号池** - 添加任意数量的 Google Gemini / Claude 账号
- ✅ **智能自动切换** - 额度不足或被限速时自动切换到下一个可用账号
- ✅ **实时监控** - 可视化显示所有账号的额度使用情况
- ✅ **本地 API 代理** - 内置兼容 OpenAI/Anthropic 协议的代理服务器
- ✅ **安全加密** - AES-256-GCM 加密存储敏感信息

---

## 🎯 功能特性

<table>
  <tr>
    <td width="50%">
      <h3>☁️ 云账号池管理</h3>
      <ul>
        <li>通过 OAuth 添加无限 Google Gemini / Claude 账号</li>
        <li>显示头像、邮箱、状态和最后使用时间</li>
        <li>实时状态监控（活跃、限速、过期）</li>
      </ul>
    </td>
    <td width="50%">
      <h3>📊 实时额度监控</h3>
      <ul>
        <li>多模型支持：gemini-pro、claude-3-5-sonnet 等</li>
        <li>可视化进度条配色指示器</li>
        <li>自动刷新与手动刷新</li>
      </ul>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🔄 智能自动切换</h3>
      <ul>
        <li>无限池模式，智能选择备用账号</li>
        <li>额度低于 5% 或被限速时自动切换</li>
        <li>后台每 5 分钟自动监控</li>
      </ul>
    </td>
    <td width="50%">
      <h3>🔐 安全优先</h3>
      <ul>
        <li>AES-256-GCM 加密敏感数据</li>
        <li>集成操作系统原生凭证管理器</li>
        <li>自动迁移旧版明文数据</li>
      </ul>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>💾 账号备份</h3>
      <ul>
        <li>捕获账号状态快照</li>
        <li>在已保存的账号间快速切换</li>
        <li>查看、整理和删除快照</li>
      </ul>
    </td>
    <td width="50%">
      <h3>⚙️ 进程控制</h3>
      <ul>
        <li>自动检测 Antigravity 是否运行</li>
        <li>通过 URI 协议或可执行文件启动</li>
        <li>优雅关闭或强制终止</li>
      </ul>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🔌 本地 API 代理</h3>
      <ul>
        <li>兼容 OpenAI & Anthropic API 协议</li>
        <li>可配置端口和请求超时</li>
        <li>模型映射（如：Claude → Gemini）</li>
      </ul>
    </td>
    <td width="50%">
      <h3>🛠️ 开发者工具</h3>
      <ul>
        <li>内置 cURL & Python 代码生成</li>
        <li>可视化服务状态监控</li>
        <li>一键重新生成 API Key</li>
      </ul>
    </td>
  </tr>
</table>

### 更多功能

- **🖥️ 系统托盘** - 后台运行，托盘图标和右键菜单
- **🔗 IDE 同步** - 自动扫描导入 IDE 的 `state.vscdb` 账号
- **📦 批量操作** - 批量刷新和删除多个账号
- **📤 JSON 导出/导入** - 导出和导入账号池，支持架构验证和去重
- **🔔 桌面通知** - 模型配额低于设定阈值时自动提醒
- **🌐 单账号代理** - 为每个账号单独配置 HTTP/SOCKS5 代理
- **📊 智能排序** - 按最近使用、总体配额或特定模型组排序
- **📋 紧凑布局** - 水平密集视图，最大化可见账号数量
- **🌏 国际化** - 多语言支持（English / 中文 / Русский）
- **🎨 现代 UI** - 基于 React、TailwindCSS 和 Shadcn UI 构建

---

## 📸 截图预览

<p align="center">
  <img src="docs/assets/screenshot-main.png" alt="主界面" width="80%" />
</p>

<p align="center">
  <img src="docs/assets/screenshot-proxy.png" alt="代理界面" width="48%" />
  <img src="docs/assets/screenshot-setting.png" alt="设置界面" width="48%" />
</p>

---

## 🚀 快速开始

### 下载安装

从 [Releases](https://github.com/Draculabo/AntigravityManager/releases) 页面下载适合你平台的最新版本。

| 平台                | 下载链接                                                                       |
| ------------------- | ------------------------------------------------------------------------------ |
| Windows (x64/ARM64) | [.exe 安装包](https://github.com/Draculabo/AntigravityManager/releases/latest) |
| macOS               | [.dmg 安装包](https://github.com/Draculabo/AntigravityManager/releases/latest) |
| Linux               | [.deb / .rpm](https://github.com/Draculabo/AntigravityManager/releases/latest) |
| NixOS / Nix         | `nix run github:Draculabo/AntigravityManager`                                  |

### ❄️ Nix 集成

你可以通过项目提供的 flake 将 Antigravity Manager 集成到你的 Nix 配置中。

#### 🛠️ NixOS / Home Manager

先在你的 `flake.nix` 的 `inputs` 中加入：

```nix
inputs = {
  nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  antigravity-manager.url = "github:Draculabo/AntigravityManager";
};
```

然后把 `antigravity-manager.overlays.default` 添加到 `nixpkgs.overlays`。这样会基于你自己的 `nixpkgs` 实例构建，并继承你的全局配置。

```nix
# 添加到你的 NixOS/Home Manager 配置中
{
  nixpkgs.overlays = [ inputs.antigravity-manager.overlays.default ];

  # Antigravity Manager 使用非自由许可证 (cc-by-nc-sa-40)
  nixpkgs.config.allowUnfree = true;

  environment.systemPackages = [
    pkgs.antigravity-manager
  ];
}
```

#### 💻 开发 Shell

如果你已经使用上面的 overlay，也可以直接在 `devShell` 里加入：

```nix
devShells.default = pkgs.mkShell {
  packages = [
    pkgs.antigravity-manager
  ];
};
```

> [!NOTE]
> 由于该包是非自由软件，你必须在 `nixpkgs` 配置中开启 `allowUnfree = true;`，否则会评估失败。

### 从源码构建

#### 前置要求

- Node.js v18 或更高版本
- npm 或 yarn

#### 步骤

```bash
# 克隆仓库
git clone https://github.com/Draculabo/AntigravityManager.git
cd AntigravityManager

# 安装依赖
npm install

# 启动开发模式
npm start

# 构建生产版本
npm run make
```

---

## 🛠️ 技术栈

| 类别         | 技术                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| **核心**     | [Electron](https://www.electronjs.org/)、[React](https://react.dev/)、[TypeScript](https://www.typescriptlang.org/) |
| **构建工具** | [Vite](https://vitejs.dev/)                                                                                         |
| **样式**     | [TailwindCSS](https://tailwindcss.com/)、[Shadcn UI](https://ui.shadcn.com/)                                        |
| **状态管理** | [TanStack Query](https://tanstack.com/query/latest)、[TanStack Router](https://tanstack.com/router/latest)          |
| **数据库**   | [Better-SQLite3](https://github.com/WiseLibs/better-sqlite3)                                                        |
| **测试**     | [Vitest](https://vitest.dev/)、[Playwright](https://playwright.dev/)                                                |

---

## 💻 开发指南

### 可用脚本

| 命令                   | 描述                     |
| ---------------------- | ------------------------ |
| `npm start`            | 启动开发模式             |
| `npm run lint`         | 运行 ESLint 检查         |
| `npm run format:write` | 使用 Prettier 格式化代码 |
| `npm run test:unit`    | 运行单元测试             |
| `npm run test:e2e`     | 运行 E2E 测试            |
| `npm run test:all`     | 运行所有测试             |
| `npm run type-check`   | TypeScript 类型检查      |
| `npm run make`         | 构建生产包               |

### 项目结构

```
AntigravityManager/
├── src/
│   ├── main.ts          # Electron 主进程
│   ├── preload.ts       # 预加载脚本
│   ├── renderer/        # React 渲染进程
│   ├── ipc/             # IPC 通信处理
│   └── server/          # 内置服务器
├── docs/                # 文档和资源
└── .github/             # GitHub 配置
```

---

## ❓ 常见问题

<details>
<summary><b>Q: 程序无法启动怎么办？</b></summary>

请检查：

1. 确保已安装所有依赖：`npm install`
2. 检查 Node.js 版本是否 >= 18
3. 尝试删除 `node_modules` 后重新安装

</details>

<details>
<summary><b>Q: 账号登录失败？</b></summary>

1. 确保网络连接正常
2. 尝试清除应用数据后重新登录
3. 检查账号是否被 Google/Claude 限制

</details>

<details>
<summary><b>Q: macOS 上提示 Keychain/凭据管理不可用，OAuth 无法保存？</b></summary>

这是 macOS 安全机制导致的常见问题，通常出现在未签名的应用或从 Downloads 直接运行的场景。
这是**临时方案**，仅适合个人设备：

1. 将应用移动到 `/Applications`
2. 打开终端执行以下命令（每次更新后都需要重新执行）

```plaintext
sudo xattr -dr com.apple.quarantine "/Applications/Antigravity Manager 2.app"
codesign --force --deep --sign - "/Applications/Antigravity Manager 2.app"
```

重新打开应用后，Keychain 应会提示授权（可选“始终允许”）。

</details>

<details>
<summary><b>Q: 如何反馈问题或建议？</b></summary>

请通过 [GitHub Issues](https://github.com/Draculabo/AntigravityManager/issues) 提交问题或建议。

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

## 🤝 贡献指南

欢迎贡献代码！请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解详情。

我们遵循 [Contributor Covenant](CODE_OF_CONDUCT.md) 行为准则。

---

## 📄 许可证

[CC BY-NC-SA 4.0](LICENSE)

---

## ⚠️ 免责声明

> [!WARNING]
> **仅供学习研究使用**
>
> 本项目仅供教育和研究目的，按"原样"提供，不提供任何保证。**严禁商业使用。**
>
> 使用本软件即表示您同意不会将其用于任何商业目的，并自行负责确保您的使用符合所有适用法律法规。作者和贡献者对因使用本软件而产生的任何滥用或损害不承担责任。

---

<p align="center">
  如果这个项目对你有帮助，请给一个 ⭐ Star 支持！
</p>
