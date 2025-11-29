# 将 Antigravity Manager 从 Python 迁移到 Electron-Shadcn

## 概述

本提案概述了将 Antigravity Manager 应用程序从基于 Python 的 Flet GUI 迁移到现代 Electron-Shadcn 框架的计划。迁移将保留所有现有功能，同时利用现代 Web 技术栈的优势。

## 背景

当前的 Antigravity Manager 使用以下技术构建：

* **Python 3.10+** 配合 Flet（基于 Flutter 的 GUI 框架）
* **SQLite** 数据库交互，用于管理 Antigravity 状态
* **跨平台**进程管理（macOS、Windows、Linux）
* **本地文件**账号备份系统

目标 Electron-Shadcn 项目提供：

* **Electron 39** 配合 React 19.2 和 TypeScript 5.9
* **Shadcn UI** 组件和 Tailwind CSS 4
* **oRPC** 用于类型安全的 IPC 通信
* **TanStack Router** 用于基于文件的路由
* **现代工具链**（Vite、ESLint、Prettier、Vitest、Playwright）

## 动机

迁移到 Electron-Shadcn 具有以下优势：

1. **现代化 UI/UX**：利用 Shadcn UI 组件和 Tailwind CSS 打造更精致、可定制的界面
2. **更好的开发体验**：TypeScript 提供类型安全，现代工具链生态系统改善开发工作流
3. **增强的可维护性**：React 组件架构比 Flet 的方法更易于维护
4. **更好的测试**：集成 Vitest 和 Playwright 进行全面测试
5. **活跃的生态系统**：React 和 Electron 拥有更大的社区和更多资源
6. **面向未来**：Web 技术比 Python GUI 框架更具前瞻性

## 目标

* ✅ 保留 Python 版本的所有现有功能
* ✅ 使用现代设计模式改进 UI/UX
* ✅ 保持跨平台兼容性（macOS、Windows、Linux）
* ✅ 实现类型安全的 IPC 通信
* ✅ 添加全面的测试覆盖
* ✅ 保持与现有账号备份的向后兼容性

## 非目标

* 更改核心账号管理逻辑或数据结构
* 添加超出当前 Python 实现的新功能
* 修改 Antigravity 数据库架构或交互模式
* 支持 macOS、Windows 和 Linux 之外的其他平台

## 需要用户审查

> \[!IMPORTANT]
> **迁移范围确认**
>
> 此迁移将完全用 Electron 应用程序替换基于 Python 的 GUI。以下方面需要确认：
>
> 1. **数据迁移**：我们是否应该为现有用户提供迁移工具，还是可以假设现有的 `~/.antigravity-agent/` 目录结构将保持兼容？
> 2. **CLI 支持**：当前 Python 版本同时具有 GUI 和 CLI 模式。我们应该保留 CLI 功能，还是只专注于 GUI？
> 3. **分发方式**：我们应该保持相同的分发方法（macOS 的 `.app`、Windows 的 `.exe`），还是利用 Electron Forge 的分发功能？

> \[!WARNING]
> **破坏性变更**
>
> 以下变更可能影响现有用户：
>
> 1. **运行时要求**：用户将不再需要安装 Python，但应用程序大小会增加（Electron 应用通常较大）
> 2. **自动更新**：我们可以使用 Electron 实现自动更新功能，这在 Python 版本中不可用
> 3. **系统集成**：应用程序将使用 Electron 的系统集成 API，而不是 Python 的平台特定方法

## 建议的更改

迁移分为以下组件：

***

### 核心应用程序结构

#### \[新建] [src/main.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/main.ts)

Electron 主进程入口点 - 模板中已存在，将扩展为：

* 窗口管理配置
* IPC 处理程序注册
* 应用程序生命周期管理

#### \[新建] [src/App.tsx](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/App.tsx)

主 React 应用程序组件 - 已存在，将更新为：

* 带侧边栏导航的应用程序布局
* 主题提供者集成
* 路由配置

***

### 账号管理模块

#### \[新建] [src/ipc/account/router.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/ipc/account/router.ts)

账号管理操作的 oRPC 路由定义：

* `listAccounts`：列出所有账号备份
* `addAccountSnapshot`：创建/更新账号备份
* `switchAccount`：切换到不同的账号
* `deleteAccount`：删除账号备份
* `getCurrentAccountInfo`：获取当前账号信息

#### \[新建] [src/ipc/account/handler.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/ipc/account/handler.ts)

账号管理处理程序的实现（`gui/account_manager.py` 的 TypeScript 移植）：

* 账号数据加载和保存
* 自动邮箱检测的备份创建
* 带进程管理的账号切换
* 带文件清理的账号删除

#### \[新建] [src/actions/account.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/actions/account.ts)

通过 oRPC 调用账号 IPC 方法的渲染进程操作

***

### 数据库管理模块

#### \[新建] [src/ipc/database/router.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/ipc/database/router.ts)

数据库操作的 oRPC 路由：

* `backupAccount`：从 SQLite 数据库备份账号数据
* `restoreAccount`：将账号数据恢复到 SQLite 数据库
* `getCurrentAccountInfo`：提取当前账号信息

#### \[新建] [src/ipc/database/handler.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/ipc/database/handler.ts)

数据库处理程序的实现（`gui/db_manager.py` 的 TypeScript 移植）：

* SQLite 数据库连接管理
* 账号数据备份到 JSON
* 从 JSON 恢复账号数据
* 账号信息提取

#### \[新建] [src/actions/database.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/actions/database.ts)

数据库操作的渲染进程操作

***

### 进程管理模块

#### \[新建] [src/ipc/process/router.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/ipc/process/router.ts)

进程管理的 oRPC 路由：

* `isProcessRunning`：检查 Antigravity 是否正在运行
* `startAntigravity`：启动 Antigravity 应用程序
* `closeAntigravity`：关闭 Antigravity 应用程序

#### \[新建] [src/ipc/process/handler.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/ipc/process/handler.ts)

进程管理处理程序的实现（`gui/process_manager.py` 的 TypeScript 移植）：

* 跨平台进程检测
* 优雅的应用程序关闭（macOS 上的 AppleScript，Windows 上的 taskkill）
* 通过可执行文件路径或 URI 协议启动应用程序

#### \[新建] [src/actions/process.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/actions/process.ts)

进程管理的渲染进程操作

***

### 工具模块

#### \[新建] [src/utils/paths.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/utils/paths.ts)

路径工具函数（`gui/utils.py` 中路径工具的 TypeScript 移植）：

* 获取应用程序数据目录
* 获取账号文件路径
* 获取 Antigravity 数据库路径
* 获取 Antigravity 可执行文件路径

#### \[新建] [src/utils/logger.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/utils/logger.ts)

日志工具（`gui/utils.py` 中日志功能的 TypeScript 移植）：

* 基于文件的日志记录
* 带颜色的控制台日志
* 日志级别（info、warning、error、debug）

***

### UI 组件

#### \[新建] [src/routes/index.tsx](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/routes/index.tsx)

主页组件（`gui/views/home_view.py` 的移植）：

* 显示 Antigravity 运行状态的状态栏
* 带当前账号高亮的账号列表
* 备份、切换和删除操作
* 实时状态监控

#### \[新建] [src/routes/settings.tsx](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/routes/settings.tsx)

设置页面组件（`gui/views/settings_view.py` 的移植）：

* 主题选择
* 应用程序偏好设置
* 关于信息

#### \[新建] [src/components/AccountCard.tsx](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/components/AccountCard.tsx)

可复用的账号卡片组件：

* 账号头像
* 账号名称和邮箱
* 最后使用时间戳
* 操作菜单（切换、删除）

#### \[新建] [src/components/StatusBar.tsx](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/components/StatusBar.tsx)

状态通知栏组件：

* 运行/停止状态指示器
* 点击启动/停止功能

#### \[新建] [src/layouts/MainLayout.tsx](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/layouts/MainLayout.tsx)

主应用程序布局：

* 侧边栏导航
* 内容区域
* 主题集成

***

### 类型定义

#### \[新建] [src/types/account.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/types/account.ts)

账号数据的 TypeScript 接口：

* `Account`：账号元数据结构
* `AccountBackupData`：备份文件结构
* `AccountInfo`：当前账号信息

***

### 配置

#### \[修改] [package.json](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/package.json)

添加依赖项：

* `better-sqlite3`：用于 SQLite 数据库访问
* `@types/better-sqlite3`：TypeScript 类型

更新产品名称和描述

#### \[修改] [forge.config.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/forge.config.ts)

配置 Electron Forge：

* 应用程序名称："Antigravity Manager"
* 图标配置
* 平台特定的构建设置

***

### 测试

#### \[新建] [src/tests/unit/account.test.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/tests/unit/account.test.ts)

账号管理逻辑的单元测试

#### \[新建] [src/tests/unit/database.test.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/tests/unit/database.test.ts)

数据库操作的单元测试

#### \[新建] [src/tests/unit/process.test.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/tests/unit/process.test.ts)

进程管理的单元测试

#### \[新建] [src/tests/e2e/account-management.spec.ts](file:///home/draculabo/workdir/frontend/Antigravity-Manager/electron-shadcn/src/tests/e2e/account-management.spec.ts)

账号管理工作流的端到端测试

## 验证计划

### 自动化测试

1. **单元测试** - 使用 Vitest 运行
   ```bash
   cd electron-shadcn
   npm run test:unit
   ```
   * 测试账号管理逻辑（创建、列表、切换、删除）
   * 测试数据库备份/恢复操作
   * 测试进程检测和管理
   * 测试路径工具

2. **端到端测试** - 使用 Playwright 运行
   ```bash
   cd electron-shadcn
   npm run package  # 先构建应用
   npm run test:e2e
   ```
   * 测试完整的账号备份工作流
   * 测试账号切换工作流
   * 测试账号删除工作流
   * 测试 Antigravity 启动/停止功能

## 验收标准

迁移完成后，必须满足以下所有验收标准才能认为项目成功：

### 功能完整性

#### 账号管理

* \[ ] **备份创建**：能够创建新账号备份，自动提取邮箱和名称
* \[ ] **备份更新**：对已存在的账号，能够更新备份而不创建重复
* \[ ] **自动备份**：应用启动时自动备份当前账号（1秒内完成）
* \[ ] **账号列表**：正确显示所有账号备份，包含名称、邮箱、时间戳
* \[ ] **当前账号标识**：清晰标识当前活动账号
* \[ ] **账号切换**：能够切换到任意账号，完整流程包括关闭→恢复→启动
* \[ ] **账号删除**：能够删除账号备份，包括文件和索引清理
* \[ ] **确认对话框**：删除操作前显示确认对话框

#### 数据库操作

* \[ ] **数据库连接**：能够连接到平台特定路径的 Antigravity 数据库
* \[ ] **数据提取**：正确提取 `antigravityAuthStatus` 和 `jetskiStateSync.agentManagerInitState` 键
* \[ ] **数据备份**：将数据库内容正确保存为 JSON 格式
* \[ ] **数据恢复**：从 JSON 正确恢复数据到数据库
* \[ ] **锁定处理**：优雅处理数据库锁定错误，提示用户关闭 Antigravity
* \[ ] **多文件支持**：支持恢复到多个数据库文件（state.vscdb 和备份文件）

#### 进程管理

* \[ ] **进程检测**：准确检测 Antigravity 是否正在运行（所有平台）
* \[ ] **优雅关闭**：使用平台特定方法优雅关闭（AppleScript/taskkill/SIGTERM）
* \[ ] **强制终止**：超时后能够强制终止进程
* \[ ] **应用启动**：能够启动 Antigravity（URI 协议或可执行文件）
* \[ ] **状态监控**：实时监控进程状态（2秒轮询间隔）
* \[ ] **多进程处理**：能够处理多个 Antigravity 进程实例

#### UI 组件

* \[ ] **主布局**：侧边栏导航 + 内容区域布局正常工作
* \[ ] **状态栏**：正确显示运行/停止状态，支持点击切换
* \[ ] **账号卡片**：显示头像、名称、邮箱、时间戳、操作菜单
* \[ ] **空状态**：无备份时显示友好的空状态提示
* \[ ] **主题切换**：支持浅色/深色/系统主题切换
* \[ ] **响应式设计**：窗口大小调整时布局正确适应
* \[ ] **错误提示**：操作失败时显示清晰的错误消息

### 跨平台兼容性

* \[ ] **macOS (Intel)**：所有功能正常工作
* \[ ] **macOS (Apple Silicon)**：所有功能正常工作
* \[ ] **Windows 10/11**：所有功能正常工作
* \[ ] **Linux (Ubuntu/Debian)**：所有功能正常工作

### 数据兼容性

* \[ ] **向后兼容**：能够读取 Python 版本创建的备份文件
* \[ ] **向前兼容**：Electron 版本创建的备份文件格式与 Python 版本一致
* \[ ] **文件结构**：使用相同的 `~/.antigravity-agent/` 目录结构
* \[ ] **数据完整性**：切换账号后，所有设置和状态正确恢复

### 性能要求

* \[ ] **启动时间**：应用启动时间 < 3 秒
* \[ ] **账号切换**：完整切换流程 < 10 秒（包括关闭和启动）
* \[ ] **UI 响应**：所有 UI 操作响应时间 < 200ms
* \[ ] **内存占用**：空闲时内存占用 < 150MB
* \[ ] **CPU 占用**：空闲时 CPU 占用 < 1%

### 测试覆盖率

* \[ ] **单元测试**：核心逻辑覆盖率 > 80%
* \[ ] **集成测试**：所有 IPC 流程有集成测试
* \[ ] **E2E 测试**：主要用户工作流有端到端测试
* \[ ] **所有测试通过**：`npm run test` 无失败

### 代码质量

* \[ ] **TypeScript 严格模式**：无类型错误
* \[ ] **ESLint**：`npm run lint` 无错误
* \[ ] **代码格式化**：所有代码通过 Prettier 格式化
* \[ ] **无 TODO 注释**：所有 TODO 已解决或转为 issue

### 文档完整性

* \[ ] **README.md**：包含 Electron 版本的安装和使用说明
* \[ ] **构建文档**：详细的构建和打包步骤
* \[ ] **开发文档**：开发环境设置和调试指南
* \[ ] **UI 截图**：包含新 UI 的截图

### 用户体验

* \[ ] **错误恢复**：所有错误场景都有清晰的提示和恢复路径
* \[ ] **加载状态**：长时间操作显示加载指示器
* \[ ] **操作反馈**：所有操作都有视觉反馈（成功/失败提示）
* \[ ] **无数据丢失**：任何情况下都不会丢失用户数据

### 安全性

* \[ ] **上下文隔离**：渲染进程启用上下文隔离
* \[ ] **Node 集成禁用**：渲染进程禁用 Node 集成
* \[ ] **IPC 验证**：所有 IPC 输入使用 Zod 验证
* \[ ] **文件访问限制**：仅访问必要的文件和目录

## 验证计划

### 手动验证

1. **跨平台测试**
   * 在 macOS（Intel 和 Apple Silicon）上构建和测试
   * 在 Windows 10/11 上构建和测试
   * 在 Linux（Ubuntu/Debian）上构建和测试

2. **功能测试**
   * 验证账号备份创建正确的 JSON 文件
   * 验证账号切换正确更新 SQLite 数据库
   * 验证 Antigravity 进程检测工作正常
   * 验证 Antigravity 的优雅关闭和启动
   * 验证 UI 主题切换（浅色/深色模式）
   * 验证与现有 Python 创建的备份的向后兼容性

3. **UI/UX 测试**
   * 验证响应式布局
   * 验证所有按钮和交互工作正常
   * 验证错误消息清晰且有帮助
   * 验证加载状态和动画

4. **数据迁移测试**
   * 使用现有的 `~/.antigravity-agent/` 目录进行测试
   * 验证现有备份可读
   * 验证新备份与旧格式兼容
