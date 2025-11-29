# 设计文档：Antigravity Manager 迁移

> \[!IMPORTANT]
> **参考实现**
>
> 当前的 Python 版本是完全可运行的参考实现。在实施 Electron 迁移过程中，如果遇到不确定的实现细节或逻辑问题，请参考 Python 代码（`gui/` 目录）中的实现。Python 代码已经过验证，可以作为迁移的权威参考。

## 架构概览

从 Python/Flet 到 Electron/React 的迁移遵循清晰的关注点分离：

```
┌─────────────────────────────────────────────────────────────┐
│                     渲染进程                                  │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  React UI 层 (TypeScript)                             │ │
│  │  - 路由 (TanStack Router)                             │ │
│  │  - 组件 (Shadcn UI)                                   │ │
│  │  - 操作 (oRPC Client)                                 │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ oRPC (类型安全 IPC)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                      主进程                                   │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  IPC 处理程序 (TypeScript)                             │ │
│  │  - 账号管理                                            │ │
│  │  - 数据库操作                                          │ │
│  │  - 进程管理                                            │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  核心服务                                              │ │
│  │  - SQLite 数据库访问 (better-sqlite3)                 │ │
│  │  - 文件系统操作 (Node.js fs)                          │ │
│  │  - 进程管理 (Node.js child_process)                   │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    外部系统                                   │
│  - Antigravity SQLite 数据库                                │
│  - 账号备份文件 (JSON)                                       │
│  - Antigravity 进程                                          │
└─────────────────────────────────────────────────────────────┘
```

## 关键设计决策

### 1. IPC 通信策略

**决策**：使用 oRPC 进行类型安全的 IPC 通信

**理由**：

* oRPC 在主进程和渲染进程之间提供端到端的类型安全
* 消除 IPC 消息不匹配导致的运行时错误
* 通过自动完成和类型检查提供更好的开发体验
* 已集成在 electron-shadcn 模板中

**考虑的替代方案**：直接使用 Electron IPC

* 由于缺乏类型安全和增加的样板代码而被拒绝

### 2. 数据库访问模式

**决策**：仅在主进程中使用 `better-sqlite3`

**理由**：

* 出于安全考虑（上下文隔离），SQLite 操作必须在主进程中运行
* `better-sqlite3` 是同步的，比异步替代方案更快
* 与异步数据库库相比，错误处理更简单
* 直接移植 Python 的同步 SQLite 方法

**考虑的替代方案**：`sqlite3`（异步）

* 由于对我们的用例来说不必要的复杂性而被拒绝

### 3. 状态管理

**决策**：使用 React Query (TanStack Query) 管理服务器状态，使用 React hooks 管理 UI 状态

**理由**：

* React Query 自动处理缓存、重新获取和同步
* 将服务器状态（账号、进程状态）与 UI 状态（对话框、表单）分离
* 内置加载和错误状态
* 已包含在 electron-shadcn 模板中

**考虑的替代方案**：Redux/Zustand

* 对于此应用程序的复杂性来说过于复杂而被拒绝

### 4. 进程管理方法

**决策**：将 Python 的多阶段关闭方法移植到 Node.js

**理由**：

* Python 实现中经过验证的方法
* 优雅关闭对数据完整性至关重要
* 平台特定的优化（macOS 上的 AppleScript，Windows 上的 taskkill）

**实现**：

```typescript
// 阶段 1：平台特定的优雅关闭
// 阶段 2：SIGTERM（终止）
// 阶段 3：SIGKILL（强制杀死）
```

### 5. 文件系统结构

**决策**：保持与 Python 版本文件结构的完全兼容性

**理由**：

* 允许用户无需数据转换即可迁移
* 与现有备份向后兼容
* 简化迁移路径

**文件结构**：

```
~/.antigravity-agent/
├── accounts.json           # 账号索引
├── app.log                 # 应用程序日志
└── backups/
    ├── <uuid-1>.json       # 账号备份 1
    ├── <uuid-2>.json       # 账号备份 2
    └── ...
```

### 6. UI 组件架构

**决策**：组件层次结构匹配 Python 的视图结构

**映射**：

```
Python (Flet)              →  React (Shadcn)
─────────────────────────────────────────────────
main.py (Sidebar)          →  MainLayout.tsx
views/home_view.py         →  routes/index.tsx
views/settings_view.py     →  routes/settings.tsx
AccountCard (内联)         →  components/AccountCard.tsx
StatusBar (内联)           →  components/StatusBar.tsx
```

### 7. 主题管理

**决策**：使用 Shadcn 的主题系统和系统偏好检测

**理由**：

* Shadcn 提供内置的深色/浅色模式支持
* CSS 变量便于自定义
* 通过 `prefers-color-scheme` 检测系统偏好
* 比 Flet 的主题系统更灵活

### 8. 错误处理策略

**决策**：分层错误处理，提供用户友好的消息

**层次**：

1. **IPC 处理程序级别**：捕获并记录错误，返回结构化错误响应
2. **React Query 级别**：处理网络/IPC 错误，显示错误状态
3. **UI 级别**：显示用户友好的错误对话框

**示例**：

```typescript
// 处理程序
try {
  await backupAccount(email, path);
  return { success: true };
} catch (error) {
  logger.error('备份失败', error);
  return { success: false, error: error.message };
}

// UI
const { mutate, isError, error } = useMutation({
  mutationFn: backupAccount,
  onError: (error) => {
    toast.error(`备份失败: ${error.message}`);
  }
});
```

## 数据流示例

### 账号备份流程

```
用户点击"备份当前"
    ↓
AccountList.tsx 调用 backupAccount 操作
    ↓
oRPC 向主进程发送 IPC 消息
    ↓
account/handler.ts 接收请求
    ↓
1. 从 SQLite 获取当前账号信息
2. 创建备份 JSON 文件
3. 更新 accounts.json 索引
    ↓
向渲染器返回成功/错误
    ↓
React Query 使缓存失效
    ↓
UI 刷新显示新的账号列表
```

### 账号切换流程

```
用户点击"切换到此账号"
    ↓
AccountCard.tsx 调用 switchAccount 操作
    ↓
oRPC 发送带账号 ID 的 IPC 消息
    ↓
account/handler.ts 接收请求
    ↓
1. 关闭 Antigravity 进程（优雅关闭）
2. 读取备份 JSON 文件
3. 将数据恢复到 SQLite 数据库
4. 启动 Antigravity 进程
5. 更新 last_used 时间戳
    ↓
向渲染器返回成功/错误
    ↓
React Query 使缓存失效
    ↓
UI 刷新显示更新的状态
```

## 跨平台考虑

### 路径解析

**macOS**：

* 应用数据：`~/Library/Application Support/Antigravity/`
* 数据库：`~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`
* 可执行文件：`/Applications/Antigravity.app`

**Windows**：

* 应用数据：`%APPDATA%/Antigravity/`
* 数据库：`%APPDATA%/Antigravity/User/globalStorage/state.vscdb`
* 可执行文件：`%LOCALAPPDATA%/Programs/Antigravity/Antigravity.exe`

**Linux**：

* 应用数据：`~/.config/Antigravity/`
* 数据库：`~/.config/Antigravity/state.vscdb`
* 可执行文件：`/usr/share/antigravity/antigravity`

### 进程管理

**macOS**：使用 AppleScript 优雅退出

```typescript
execSync('osascript -e \'tell application "Antigravity" to quit\'');
```

**Windows**：使用 taskkill 优雅终止

```typescript
execSync('taskkill /IM Antigravity.exe /T');
```

**Linux**：SIGTERM 信号

```typescript
process.kill(pid, 'SIGTERM');
```

## 安全考虑

1. **上下文隔离**：在 electron-shadcn 中默认启用
2. **Node 集成**：在渲染进程中禁用
3. **IPC 验证**：所有 IPC 输入使用 Zod 模式验证
4. **文件访问**：限制在 `~/.antigravity-agent/` 目录
5. **数据库访问**：对 Antigravity 数据库只读访问，仅对备份有写入访问权限

## 性能考虑

1. **数据库操作**：由于数据量小，同步操作是可接受的
2. **进程监控**：轮询间隔为 2 秒（与 Python 版本相同）
3. **UI 渲染**：React Query 缓存减少不必要的重新渲染
4. **包大小**：路由代码分割以减少初始加载时间

## 测试策略

### 单元测试 (Vitest)

* 独立测试每个 IPC 处理程序
* 模拟文件系统和数据库操作
* 测试工具函数（路径解析、日志记录）

### 集成测试 (Vitest)

* 测试完整的 IPC 流程（渲染器 → 主进程 → 响应）
* 使用临时数据库测试数据库备份/恢复
* 使用模拟进程测试进程检测

### 端到端测试 (Playwright)

* 测试完整的用户工作流
* 测试跨平台兼容性
* 测试错误场景和恢复

## 迁移路径

### 对于开发者

1. 设置 Electron-Shadcn 项目
2. 实现 IPC 处理程序（主进程）
3. 实现 UI 组件（渲染进程）
4. 编写测试
5. 构建和打包

### 对于用户

1. 下载新的 Electron 版本
2. 现有的 `~/.antigravity-agent/` 数据自动工作
3. 无需手动迁移

## 待解决问题

1. **CLI 支持**：我们应该保留 CLI 功能吗？
   * **建议**：首先专注于 GUI，如果需要稍后添加 CLI

2. **自动更新**：我们应该实现自动更新吗？
   * **建议**：是的，使用 `update-electron-app`（已在依赖项中）

3. **遥测**：我们应该添加使用分析吗？
   * **建议**：否，像 Python 版本一样保持隐私优先

## 未来增强功能

这些明确不在初始迁移范围内，但记录以供将来参考：

1. **云同步**：跨设备同步账号备份
2. **账号导入/导出**：导出备份以与他人共享
3. **备份加密**：加密备份文件以提高安全性
4. **多账号切换**：无需完全重启即可快速切换账号
5. **备份调度**：自动定期备份
