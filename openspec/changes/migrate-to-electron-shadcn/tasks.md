# 实施任务

> \[!TIP]
> **Python 参考实现**
>
> 当前 Python 版本（`gui/` 目录）是完全可运行的参考实现。在实施每个模块时，请参考对应的 Python 文件以了解具体的实现逻辑和边界情况处理。

本文档概述了将 Antigravity Manager 从 Python 迁移到 Electron-Shadcn 的有序实施任务。

## 阶段 1：项目设置和基础设施

### 1.1 配置 Electron-Shadcn 项目

* \[ ] 使用项目名称 "Antigravity Manager" 更新 `package.json`
* \[ ] 添加 `better-sqlite3` 依赖项用于 SQLite 访问
* \[ ] 添加 `@types/better-sqlite3` 用于 TypeScript 类型
* \[ ] 使用应用程序名称和图标路径更新 `forge.config.ts`
* \[ ] 为 macOS、Windows 和 Linux 配置构建设置

**验证**：运行 `npm install` 并验证没有错误

***

### 1.2 设置项目结构

* \[ ] 创建 `src/ipc/account/` 目录
* \[ ] 创建 `src/ipc/database/` 目录
* \[ ] 创建 `src/ipc/process/` 目录
* \[ ] 创建 `src/utils/` 目录（如果不存在）
* \[ ] 创建 `src/types/` 目录（如果不存在）
* \[ ] 根据需要创建 `src/components/` 子目录

**验证**：验证目录结构与 design.md 匹配

***

## 阶段 2：核心工具和类型

### 2.1 实现路径工具

* \[ ] 创建 `src/utils/paths.ts`
* \[ ] 实现 `getAppDataDir()` 函数
* \[ ] 实现 `getAccountsFilePath()` 函数
* \[ ] 为所有平台实现 `getAntigravityDbPaths()` 函数
* \[ ] 为所有平台实现 `getAntigravityExecutablePath()` 函数
* \[ ] 在 `src/tests/unit/paths.test.ts` 中添加单元测试

**验证**：运行 `npm run test:unit -- paths.test.ts` 并验证所有测试通过

***

### 2.2 实现日志工具

* \[ ] 创建 `src/utils/logger.ts`
* \[ ] 实现基于文件的日志记录到 `~/.antigravity-agent/app.log`
* \[ ] 实现带颜色支持的控制台日志
* \[ ] 实现日志级别（info、warning、error、debug）
* \[ ] 在 `src/tests/unit/logger.test.ts` 中添加单元测试

**验证**：运行 `npm run test:unit -- logger.test.ts` 并验证所有测试通过

***

### 2.3 定义 TypeScript 类型

* \[ ] 创建 `src/types/account.ts`
* \[ ] 定义 `Account` 接口
* \[ ] 定义 `AccountBackupData` 接口
* \[ ] 定义 `AccountInfo` 接口
* \[ ] 定义用于验证的 Zod 模式

**验证**：运行 `npm run lint` 并验证没有类型错误

***

## 阶段 3：数据库操作模块

### 3.1 实现数据库处理程序

* \[ ] 创建 `src/ipc/database/handler.ts`
* \[ ] 实现 `getDatabaseConnection()` 函数
* \[ ] 实现 `backupAccount()` 函数
* \[ ] 实现 `restoreAccount()` 函数
* \[ ] 实现 `getCurrentAccountInfo()` 函数
* \[ ] 添加数据库锁定错误的错误处理
* \[ ] 在 `src/tests/unit/database.test.ts` 中添加单元测试

**验证**：运行 `npm run test:unit -- database.test.ts` 并验证所有测试通过

***

### 3.2 创建数据库 IPC 路由

* \[ ] 创建 `src/ipc/database/router.ts`
* \[ ] 使用数据库操作定义 oRPC 路由
* \[ ] 添加用于输入/输出验证的 Zod 模式
* \[ ] 在 `src/ipc/router.ts` 中注册路由

**验证**：运行 `npm run lint` 并验证没有类型错误

***

### 3.3 创建数据库操作

* \[ ] 创建 `src/actions/database.ts`
* \[ ] 使用 oRPC 客户端实现渲染器端操作函数
* \[ ] 导出类型化的操作函数

**验证**：运行 `npm run lint` 并验证没有类型错误

***

## 阶段 4：进程管理模块

### 4.1 实现进程处理程序

* \[ ] 创建 `src/ipc/process/handler.ts`
* \[ ] 为所有平台实现 `isProcessRunning()` 函数
* \[ ] 实现带 3 阶段关闭的 `closeAntigravity()` 函数
* \[ ] 实现带 URI 和可执行文件回退的 `startAntigravity()` 函数
* \[ ] 在 `src/tests/unit/process.test.ts` 中添加单元测试

**验证**：运行 `npm run test:unit -- process.test.ts` 并验证所有测试通过

***

### 4.2 创建进程 IPC 路由

* \[ ] 创建 `src/ipc/process/router.ts`
* \[ ] 使用进程操作定义 oRPC 路由
* \[ ] 添加用于输入/输出验证的 Zod 模式
* \[ ] 在 `src/ipc/router.ts` 中注册路由

**验证**：运行 `npm run lint` 并验证没有类型错误

***

### 4.3 创建进程操作

* \[ ] 创建 `src/actions/process.ts`
* \[ ] 使用 oRPC 客户端实现渲染器端操作函数
* \[ ] 导出类型化的操作函数

**验证**：运行 `npm run lint` 并验证没有类型错误

***

## 阶段 5：账号管理模块

### 5.1 实现账号处理程序

* \[ ] 创建 `src/ipc/account/handler.ts`
* \[ ] 实现 `loadAccounts()` 函数
* \[ ] 实现 `saveAccounts()` 函数
* \[ ] 实现 `addAccountSnapshot()` 函数
* \[ ] 实现 `switchAccount()` 函数
* \[ ] 实现 `deleteAccount()` 函数
* \[ ] 实现 `listAccountsData()` 函数
* \[ ] 在 `src/tests/unit/account.test.ts` 中添加单元测试

**验证**：运行 `npm run test:unit -- account.test.ts` 并验证所有测试通过

***

### 5.2 创建账号 IPC 路由

* \[ ] 创建 `src/ipc/account/router.ts`
* \[ ] 使用账号操作定义 oRPC 路由
* \[ ] 添加用于输入/输出验证的 Zod 模式
* \[ ] 在 `src/ipc/router.ts` 中注册路由

**验证**：运行 `npm run lint` 并验证没有类型错误

***

### 5.3 创建账号操作

* \[ ] 创建 `src/actions/account.ts`
* \[ ] 使用 oRPC 客户端实现渲染器端操作函数
* \[ ] 导出类型化的操作函数

**验证**：运行 `npm run lint` 并验证没有类型错误

***

## 阶段 6：UI 组件

### 6.1 创建 StatusBar 组件

* \[ ] 创建 `src/components/StatusBar.tsx`
* \[ ] 实现运行/停止状态显示
* \[ ] 实现点击启动/停止功能
* \[ ] 添加 React Query 用于实时状态监控
* \[ ] 使用 Shadcn UI 和 Tailwind CSS 设置样式

**验证**：运行 `npm run start` 并验证组件正确渲染

***

### 6.2 创建 AccountCard 组件

* \[ ] 创建 `src/components/AccountCard.tsx`
* \[ ] 实现账号头像显示
* \[ ] 实现账号名称、邮箱和时间戳显示
* \[ ] 为当前账号实现"当前"徽章
* \[ ] 实现带切换和删除的操作菜单
* \[ ] 添加悬停效果
* \[ ] 使用 Shadcn UI 和 Tailwind CSS 设置样式

**验证**：运行 `npm run start` 并验证组件正确渲染

***

### 6.3 创建 MainLayout 组件

* \[ ] 创建 `src/layouts/MainLayout.tsx`
* \[ ] 实现侧边栏导航
* \[ ] 实现内容区域
* \[ ] 实现主题集成
* \[ ] 使用 Shadcn UI 和 Tailwind CSS 设置样式

**验证**：运行 `npm run start` 并验证布局正确渲染

***

## 阶段 7：页面和路由

### 7.1 实现主页

* \[ ] 创建 `src/routes/index.tsx`
* \[ ] 实现状态栏集成
* \[ ] 实现账号列表显示
* \[ ] 实现"备份当前"按钮
* \[ ] 实现无备份的空状态
* \[ ] 实现挂载时自动备份
* \[ ] 添加 React Query 用于数据获取和缓存
* \[ ] 使用 Shadcn UI 和 Tailwind CSS 设置样式

**验证**：运行 `npm run start` 并验证页面功能

***

### 7.2 实现设置页面

* \[ ] 创建 `src/routes/settings.tsx`
* \[ ] 实现主题选择
* \[ ] 实现关于部分
* \[ ] 使用 Shadcn UI 和 Tailwind CSS 设置样式

**验证**：运行 `npm run start` 并验证页面功能

***

### 7.3 更新应用路由

* \[ ] 更新 `src/App.tsx` 以使用 MainLayout
* \[ ] 使用路由配置 TanStack Router
* \[ ] 测试页面之间的导航

**验证**：运行 `npm run start` 并验证路由工作正常

***

## 阶段 8：集成和测试

### 8.1 编写端到端测试

* \[ ] 创建 `src/tests/e2e/account-management.spec.ts`
* \[ ] 测试账号备份工作流
* \[ ] 测试账号切换工作流
* \[ ] 测试账号删除工作流
* \[ ] 测试 Antigravity 启动/停止功能

**验证**：运行 `npm run package && npm run test:e2e` 并验证所有测试通过

***

### 8.2 手动跨平台测试

* \[ ] 在 macOS（Intel）上测试
* \[ ] 在 macOS（Apple Silicon）上测试
* \[ ] 在 Windows 10/11 上测试
* \[ ] 在 Linux（Ubuntu/Debian）上测试
* \[ ] 验证与 Python 创建的备份的向后兼容性

**验证**：在每个平台上手动测试

***

### 8.3 构建和打包

* \[ ] 为 macOS 运行 `npm run make`
* \[ ] 为 Windows 运行 `npm run make`
* \[ ] 为 Linux 运行 `npm run make`
* \[ ] 验证安装程序正常工作
* \[ ] 测试已安装的应用程序

**验证**：在每个平台上安装并运行打包的应用程序

***

## 阶段 9：文档和清理

### 9.1 更新文档

* \[ ] 使用 Electron 特定说明更新 README.md
* \[ ] 记录构建过程
* \[ ] 记录开发工作流
* \[ ] 添加新 UI 的屏幕截图

**验证**：审查文档的完整性

***

### 9.2 代码清理

* \[ ] 删除未使用的 Python 文件（或移至存档）
* \[ ] 运行 `npm run lint` 并修复所有问题
* \[ ] 运行 `npm run format:write` 格式化代码
* \[ ] 删除任何 TODO 注释

**验证**：运行 `npm run lint` 并验证没有错误

***

## 任务之间的依赖关系

* **阶段 2** 必须在阶段 3、4、5 之前完成（所有模块都需要工具）
* **阶段 3、4、5** 可以并行完成（独立模块）
* **阶段 6** 依赖于阶段 5（UI 需要账号操作）
* **阶段 7** 依赖于阶段 6（页面使用组件）
* **阶段 8** 依赖于阶段 7（测试需要完整实现）
* **阶段 9** 可以在阶段 8 之后完成

## 并行化机会

* 阶段 3、4、5 可以由不同的开发人员同时实现
* 阶段 6 中的 UI 组件可以并行构建
* 端到端测试可以在进行手动测试时编写
