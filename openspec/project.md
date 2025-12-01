# Project Context

## Purpose

Antigravity Manager 是一个综合性的 Antigravity 增强工具，旨在打破 AI 开发的资源限制。它不仅解决了 Antigravity IDE 客户端无法原生支持多账号切换的痛点，还引入了企业级的 AI 服务账号池管理功能。通过接管应用的配置状态和云端 API 资源，它允许用户在无限个本地账号和云端 AI 服务之间无缝切换，实现 "无限" 的 AI 调用体验。

**核心目标：**

*   **本地多账号切换**：无缝切换 Antigravity IDE 的本地用户状态，保护数据完整性（自动备份）。
*   **AI 资源池管理**（新）：集中管理 Google Gemini、Claude 3.5 等 AI 服务的账号池。
*   **智能配额监控**（新）：实时监控 API 配额（Quota）和健康度，提供可视化仪表盘。
*   **自动资源调度**（新）：当当前账号配额耗尽时，自动切换到最佳可用账号（Token 保活与轮询）。
*   **跨平台支持**：统一的 macOS、Windows、Linux 体验。

## Tech Stack

*   **Electron 39** - 跨平台桌面应用框架
*   **React 19.2** - UI 框架
*   **TypeScript 5.9** - 类型安全的开发语言
*   **Shadcn UI** - 现代化 UI 组件库
*   **Tailwind CSS 4** - 样式框架
*   **oRPC** - 类型安全的 IPC 通信
*   **TanStack Router** - 文件路由
*   **React Query** - 服务器状态管理
*   **better-sqlite3** - SQLite 数据库访问
*   **Vite** - 构建工具
*   **Vitest** - 单元测试
*   **Playwright** - 端到端测试
*   **Electron Forge** - 应用打包和分发

## Project Conventions

### Code Style

*   TypeScript strict mode
*   ESLint + Prettier 自动格式化
*   函数和变量使用 camelCase
*   组件使用 PascalCase
*   接口使用 PascalCase，以 I 开头（可选）
*   类型使用 PascalCase
*   2 空格缩进
*   单引号字符串
*   尾随逗号

### Architecture Patterns

```
src/
├── main.ts              # Electron 主进程
├── preload.ts           # 预加载脚本
├── renderer.ts          # 渲染进程入口
├── ipc/                 # IPC 通信层
│   ├── account/         # 本地 IDE 账号管理 IPC
│   ├── cloud/           # 云端 AI 资源管理 IPC（新）
│   ├── database/        # 数据库操作 IPC
│   └── process/         # 进程管理 IPC
├── services/            # 业务逻辑服务层（新）
│   ├── QuotaService.ts  # 配额监控服务
│   └── TokenService.ts  # Token 保活服务
├── actions/             # 渲染进程操作（oRPC 客户端）
├── components/          # React 组件
├── routes/              # 页面路由
├── layouts/             # 布局组件
├── utils/               # 工具函数
├── types/               # TypeScript 类型定义
└── tests/               # 测试文件
```

**设计模式：**

*   **关注点分离**：主进程处理系统操作和网络代理，渲染进程处理 UI。
*   **Service 层**：引入 Service 层处理复杂的配额轮询和 Token 刷新逻辑。
*   **类型安全 IPC**：使用 oRPC 确保主进程和渲染进程之间的类型安全通信。
*   **状态管理**：React Query 管理服务器状态和异步配额数据。

### Testing Strategy

*   **单元测试（Vitest）**：测试 IPC 处理程序、Service 逻辑、工具函数。
*   **集成测试（Vitest）**：测试完整的 IPC 流程。
*   **端到端测试（Playwright）**：测试用户工作流。
*   **覆盖率目标**：核心逻辑 >80%。

### Git Workflow

*   **主分支**：`main`
*   **开发分支**：`develop`
*   **提交规范**：语义化提交 (feat, fix, docs, refactor, test, chore)

## Domain Context

### 1. Antigravity IDE 数据结构（本地）

**数据库位置：**
* macOS: `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`
* Windows: `%APPDATA%/Antigravity/User/globalStorage/state.vscdb`
* Linux: `~/.config/Antigravity/state.vscdb`

**关键数据库键：**
* `antigravityAuthStatus`: 认证状态和用户信息。

### 2. AI 服务资源结构（云端/新）

**账号模型：**
```json
{
  "id": "uuid",
  "provider": "google" | "anthropic",
  "email": "user@example.com",
  "auth_token": "oauth2_token...",
  "refresh_token": "...",
  "quota_limit": 1000,
  "quota_used": 450,
  "reset_time": "ISO 8601",
  "status": "active" | "rate_limited" | "expired"
}
```

### 3. 进程管理策略

*   **三阶段关闭**：优雅关闭 -> SIGTERM -> SIGKILL。

## Important Constraints

### 技术约束

*   **数据库访问**：访问本地 IDE 数据库时需注意文件锁。
*   **网络访问**：需要访问外部 API (Google/Anthropic) 以获取配额信息。
*   **凭证安全**：OAuth Token 和 Refresh Token 必须使用系统级加密存储 (Keytar / SQLite Encrypted)。
*   **并发控制**：轮询配额时需注意频率，避免触发 API 封控。

### 用户体验约束

*   **响应时间**：账号切换应在 5 秒内完成。
*   **静默运行**：支持最小化到托盘，后台自动刷新 Token。
*   **数据安全**：切换前必须自动备份当前状态。

## External Dependencies

### 系统依赖

*   **Antigravity IDE**：本地管理目标。
*   **SQLite**：本地数据读取。

### Node.js 依赖（重点）

*   `better-sqlite3`: 数据库访问。
*   `electron`: 桌面框架。
*   `node-fetch` / `axios`: 网络请求。
*   `tar` / `adm-zip`: 备份压缩。

### 外部服务

*   **Google Gemini API**: 用于配额检查。
*   **Anthropic API**: 用于配额检查。
*   **OAuth 2.0 端点**: 用于账号授权。

### 文件系统依赖

*   `~/.antigravity-agent/`
    *   `accounts.json`: 本地 IDE 账号索引。
    *   `cloud_accounts.db`: (新) 云端账号池数据库 (SQLite)。
    *   `backups/`: 备份文件。
    *   `app.log`: 应用日志。
