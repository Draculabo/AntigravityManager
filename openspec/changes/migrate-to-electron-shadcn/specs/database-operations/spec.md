# 数据库操作能力

## ADDED Requirements

### Requirement: 系统必须提供安全的 SQLite 数据库访问

系统应为备份和恢复操作提供对 Antigravity SQLite 数据库的安全访问。

#### Scenario: 连接到 Antigravity 数据库

**Given** Antigravity 应用程序已安装
**When** 系统需要访问数据库
**Then** 系统应：

1. 在平台特定路径定位数据库文件
2. 为备份操作建立只读连接
3. 为恢复操作建立读写连接
4. 优雅地处理数据库锁定错误

#### Scenario: 数据库未找到

**Given** Antigravity 数据库不存在
**When** 系统尝试连接
**Then** 系统应：

1. 返回指示未找到数据库的错误
2. 记录尝试的路径以供调试
3. 显示用户友好的错误消息

***

### Requirement: 系统必须将账号数据备份到 JSON 文件

系统应将 Antigravity 数据库中的特定键备份到 JSON 文件。

#### Scenario: 备份账号数据

**Given** 已连接到 Antigravity 数据库
**When** 发起备份操作
**Then** 系统应：

1. 从 `ItemTable` 提取 `antigravityAuthStatus` 键
2. 从 `ItemTable` 提取 `jetskiStateSync.agentManagerInitState` 键
3. 添加元数据：`account_email` 和 `backup_time`
4. 将所有数据以适当格式写入 JSON 文件
5. 确保 JSON 文件有效且可读

#### Scenario: 缺少数据库键

**Given** 数据库中缺少某些必需的键
**When** 备份操作运行
**Then** 系统应：

1. 继续备份可用的键
2. 记录缺少键的警告
3. 使用可用数据创建有效的备份文件

***

### Requirement: 系统必须从 JSON 备份恢复账号数据

系统应从 JSON 备份文件将账号数据恢复到 Antigravity 数据库。

#### Scenario: 恢复账号数据

**Given** 存在有效的备份 JSON 文件
**When** 发起恢复操作
**Then** 系统应：

1. 读取并解析 JSON 备份文件
2. 在 `ItemTable` 中插入或替换 `antigravityAuthStatus` 键
3. 在 `ItemTable` 中插入或替换 `jetskiStateSync.agentManagerInitState` 键
4. 提交数据库事务
5. 验证数据已成功写入

#### Scenario: 恢复到多个数据库文件

**Given** 存在多个 Antigravity 数据库文件（例如 `state.vscdb` 和 `state.vscdb.backup`）
**When** 恢复操作运行
**Then** 系统应将数据恢复到所有数据库文件以保持一致性

#### Scenario: 无效的备份文件

**Given** 损坏或无效的备份 JSON 文件
**When** 发起恢复操作
**Then** 系统应：

1. 优雅地失败而不修改数据库
2. 记录带有详细信息的错误
3. 向调用者返回错误

***

### Requirement: 系统必须从数据库中提取当前账号信息

系统应从 Antigravity 数据库中提取当前账号的邮箱。

#### Scenario: 提取账号邮箱

**Given** Antigravity 中有已登录的账号
**When** 系统查询当前账号信息
**Then** 系统应：

1. 从 `ItemTable` 查询 `antigravityAuthStatus` 键
2. 解析 JSON 值以提取邮箱字段
3. 返回邮箱地址

#### Scenario: 未找到账号邮箱

**Given** 没有账号登录或邮箱未存储
**When** 系统查询当前账号信息
**Then** 系统应：

1. 尝试替代键（`google.antigravity`、`antigravityUserSettings.allUserSettings`）
2. 如果未找到邮箱则返回 `null`
3. 记录尝试以供调试

***

### Requirement: 系统必须高效管理数据库连接

系统应高效且安全地管理数据库连接。

#### Scenario: 处理数据库锁定错误

**Given** Antigravity 应用程序正在运行
**When** 系统尝试访问数据库
**Then** 系统应：

1. 检测"数据库已锁定"错误
2. 返回指示必须关闭 Antigravity 的特定错误消息
3. 不无限重试

#### Scenario: 关闭数据库连接

**Given** 数据库操作完成
**When** 操作结束（成功或错误）
**Then** 系统应关闭数据库连接以防止资源泄漏
