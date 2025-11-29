# 账号管理能力

## ADDED Requirements

### Requirement: 系统必须提供账号备份创建功能

系统应提供从当前 Antigravity 状态创建和更新账号备份的功能。

#### Scenario: 创建新账号备份

**Given** Antigravity 正在运行且有已登录的账号
**When** 用户点击"备份当前"按钮
**Then** 系统应：

1. 从 Antigravity SQLite 数据库中提取当前账号邮箱
2. 如果账号不存在，则为其创建新的 UUID
3. 将账号数据备份到 `~/.antigravity-agent/backups/<uuid>.json`
4. 将账号元数据添加到 `~/.antigravity-agent/accounts.json`
5. 在账号列表中显示新备份

#### Scenario: 更新现有账号备份

**Given** 当前邮箱的账号备份已存在
**When** 用户点击"备份当前"按钮
**Then** 系统应：

1. 通过匹配邮箱识别现有备份
2. 用当前数据覆盖现有备份文件
3. 更新账号元数据中的 `last_used` 时间戳
4. 保留原始的 `created_at` 时间戳和 UUID

#### Scenario: 启动时自动备份

**Given** 应用程序启动
**When** 主窗口加载
**Then** 系统应在 1 秒内自动创建/更新当前账号的备份

***

### Requirement: 系统必须在列表中显示所有账号备份

系统应在列表中显示所有账号备份及相关元数据。

#### Scenario: 显示账号列表

**Given** 存在多个账号备份
**When** 用户查看主页
**Then** 系统应显示：

1. 每个账号的名称、邮箱和最后使用时间戳
2. 当前活动账号的视觉指示器
3. 带有账号名称首字母的头像
4. 徽章中的备份总数

#### Scenario: 空账号列表

**Given** 不存在账号备份
**When** 用户查看主页
**Then** 系统应显示带图标的消息"暂无备份记录"

***

### Requirement: 系统必须允许用户在账号备份之间切换

系统应允许用户在不同的账号备份之间切换。

#### Scenario: 切换到不同账号

**Given** 存在多个账号备份
**And** Antigravity 正在运行
**When** 用户从账号菜单中选择"切换到此账号"
**Then** 系统应：

1. 优雅地关闭 Antigravity 应用程序
2. 将所选账号的数据恢复到 Antigravity 数据库
3. 重新启动 Antigravity 应用程序
4. 更新所选账号的 `last_used` 时间戳
5. 刷新 UI 以显示新的当前账号

#### Scenario: 由于进程未关闭导致切换失败

**Given** 用户发起账号切换
**When** Antigravity 进程在 10 秒内未能关闭
**Then** 系统应：

1. 尝试强制终止进程
2. 继续进行账号恢复
3. 记录错误以供调试

***

### Requirement: 系统必须允许用户删除账号备份

系统应允许用户删除账号备份。

#### Scenario: 删除账号备份

**Given** 存在账号备份
**When** 用户从账号菜单中选择"删除备份"
**And** 在对话框中确认删除
**Then** 系统应：

1. 从 `~/.antigravity-agent/backups/` 删除备份文件
2. 从 `accounts.json` 中删除账号元数据
3. 刷新账号列表
4. 显示成功消息

#### Scenario: 取消账号删除

**Given** 用户从账号菜单中选择"删除备份"
**When** 用户在确认对话框中点击"取消"
**Then** 系统不应删除账号并关闭对话框

***

### Requirement: 系统必须使用类型安全的 IPC 通信

系统应使用 oRPC 在渲染进程和主进程之间进行类型安全的通信。

#### Scenario: IPC 类型安全

**Given** 已定义账号管理 IPC 路由
**When** 渲染进程调用账号操作
**Then** TypeScript 应强制执行：

1. IPC 调用的正确参数类型
2. IPC 处理程序的正确返回类型
3. 类型不匹配的编译时错误

#### Scenario: IPC 错误处理

**Given** IPC 处理程序遇到错误
**When** 发生错误
**Then** 系统应：

1. 记录带有完整堆栈跟踪的错误
2. 向渲染器返回结构化错误响应
3. 在 UI 中显示用户友好的错误消息
