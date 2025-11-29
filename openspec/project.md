# Project Context

## Purpose

Antigravity Manager 是一个跨平台的账号管理工具，旨在解决 Antigravity IDE 客户端无法原生支持多账号切换的痛点。通过接管应用的配置状态，它允许用户在无限个账号之间一键无缝切换，同时提供自动备份、进程守护和可视化的管理界面。

**核心目标：**

* 提供无缝的多账号切换体验
* 保护用户数据完整性（自动备份机制）
* 跨平台支持（macOS、Windows、Linux）
* 现代化的用户界面

## Tech Stack

### 当前技术栈（Python 版本）

* **Python 3.10+** - 核心运行时
* **Flet** - 基于 Flutter 的跨平台 GUI 框架
* **SQLite3** - 数据库交互（读取 Antigravity 状态）
* **psutil** - 跨平台进程管理
* **PyInstaller** - 应用打包

### 目标技术栈（Electron 迁移）

* **Electron 39** - 跨平台桌面应用框架
* **React 19.2** - UI 框架
* **TypeScript 5.9** - 类型安全的开发语言
* **Shadcn UI** - 现代化 UI 组件库
* **Tailwind CSS 4** - 样式框架
* **oRPC** - 类型安全的 IPC 通信
* **TanStack Router** - 文件路由
* **React Query** - 服务器状态管理
* **better-sqlite3** - SQLite 数据库访问
* **Vite** - 构建工具
* **Vitest** - 单元测试
* **Playwright** - 端到端测试
* **Electron Forge** - 应用打包和分发

## Project Conventions

### Code Style

**Python 版本：**

* 使用 UTF-8 编码
* 函数和变量使用 snake\_case
* 类名使用 PascalCase
* 中文注释和日志消息
* 4 空格缩进

**Electron 版本（目标）：**

* TypeScript strict mode
* ESLint + Prettier 自动格式化
* 函数和变量使用 camelCase
* 组件使用 PascalCase
* 接口使用 PascalCase，以 I 开头（可选）
* 类型使用 PascalCase
* 2 空格缩进
* 单引号字符串
* 尾随逗号

### Architecture Patterns

**当前架构（Python）：**

```
gui/
├── main.py              # GUI 入口，Flet 应用
├── account_manager.py   # 账号 CRUD 逻辑
├── db_manager.py        # SQLite 数据库操作
├── process_manager.py   # 进程检测和控制
├── utils.py             # 工具函数（日志、路径）
└── views/               # UI 视图
    ├── home_view.py     # 主页（账号列表）
    └── settings_view.py # 设置页
```

**目标架构（Electron）：**

```
src/
├── main.ts              # Electron 主进程
├── preload.ts           # 预加载脚本
├── renderer.ts          # 渲染进程入口
├── ipc/                 # IPC 通信层
│   ├── account/         # 账号管理 IPC
│   ├── database/        # 数据库操作 IPC
│   └── process/         # 进程管理 IPC
├── actions/             # 渲染进程操作（oRPC 客户端）
├── components/          # React 组件
├── routes/              # 页面路由
├── layouts/             # 布局组件
├── utils/               # 工具函数
├── types/               # TypeScript 类型定义
└── tests/               # 测试文件
```

**设计模式：**

* **关注点分离**：主进程处理系统操作，渲染进程处理 UI
* **类型安全 IPC**：使用 oRPC 确保主进程和渲染进程之间的类型安全通信
* **状态管理**：React Query 管理服务器状态，React hooks 管理 UI 状态
* **组件化**：可复用的 UI 组件（AccountCard、StatusBar 等）

### Testing Strategy

**当前（Python）：**

* 手动测试为主
* 跨平台手动验证

**目标（Electron）：**

* **单元测试（Vitest）**：测试 IPC 处理程序、工具函数
* **集成测试（Vitest）**：测试完整的 IPC 流程
* **端到端测试（Playwright）**：测试用户工作流
* **跨平台测试**：在 macOS、Windows、Linux 上验证
* **测试覆盖率目标**：核心逻辑 >80%

### Git Workflow

* **主分支**：`main` - 稳定版本
* **开发分支**：`develop` - 开发中的功能
* **功能分支**：`feature/<feature-name>` - 新功能开发
* **修复分支**：`fix/<bug-name>` - Bug 修复
* **提交规范**：使用语义化提交消息
  * `feat:` - 新功能
  * `fix:` - Bug 修复
  * `docs:` - 文档更新
  * `refactor:` - 代码重构
  * `test:` - 测试相关
  * `chore:` - 构建/工具相关

## Domain Context

### Antigravity IDE 数据结构

**数据库位置：**

* macOS: `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`
* Windows: `%APPDATA%/Antigravity/User/globalStorage/state.vscdb`
* Linux: `~/.config/Antigravity/state.vscdb`

**关键数据库键：**

* `antigravityAuthStatus` - 认证状态和用户信息
* `jetskiStateSync.agentManagerInitState` - Agent 管理器状态

**账号备份结构：**

```json
{
  "id": "uuid",
  "name": "账号名称",
  "email": "user@example.com",
  "backup_file": "~/.antigravity-agent/backups/<uuid>.json",
  "created_at": "ISO 8601 时间戳",
  "last_used": "ISO 8601 时间戳"
}
```

### 进程管理策略

**三阶段关闭流程：**

1. **优雅关闭**：平台特定方法（macOS 用 AppleScript，Windows 用 taskkill）
2. **SIGTERM**：温和终止信号
3. **SIGKILL**：强制终止（最后手段）

**超时设置：**

* 优雅关闭等待：2 秒
* SIGTERM 等待：10 秒
* 总超时：12 秒

## Important Constraints

### 技术约束

* **数据库访问**：必须在 Antigravity 关闭时访问数据库（避免锁定）
* **进程检测**：需要跨平台的进程检测机制
* **文件权限**：需要读写 `~/.antigravity-agent/` 目录的权限
* **向后兼容**：新版本必须能读取旧版本创建的备份文件

### 平台约束

* **macOS**：需要 AppleScript 权限用于优雅关闭
* **Windows**：需要处理 UAC 和进程权限
* **Linux**：需要处理不同的桌面环境

### 用户体验约束

* **响应时间**：账号切换应在 5 秒内完成
* **数据安全**：切换前必须自动备份当前状态
* **错误恢复**：失败时应提供清晰的错误消息和恢复选项

## External Dependencies

### 系统依赖

* **Antigravity IDE**：必须已安装（应用的管理目标）
* **SQLite**：用于读取 Antigravity 数据库
* **操作系统**：macOS 10.15+、Windows 10+、Linux（主流发行版）

### Python 依赖（当前）

* `flet` - GUI 框架
* `psutil` - 进程管理

### Node.js 依赖（目标）

* `better-sqlite3` - SQLite 访问
* `electron` - 桌面应用框架
* 完整列表见 `electron-shadcn/package.json`

### 外部服务

* **无** - 完全离线运行，不依赖任何外部 API 或服务

### 文件系统依赖

* `~/.antigravity-agent/` - 应用数据目录
  * `accounts.json` - 账号索引
  * `backups/` - 账号备份文件
  * `app.log` - 应用日志
