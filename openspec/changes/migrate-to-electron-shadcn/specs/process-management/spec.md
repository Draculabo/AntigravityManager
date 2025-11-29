# 进程管理能力

## ADDED Requirements

### Requirement: 系统必须检测正在运行的 Antigravity 进程

系统应检测 Antigravity 应用程序当前是否正在运行。

#### Scenario: 在 macOS 上检测正在运行的 Antigravity 进程

**Given** 系统是 macOS
**When** 进程检测运行
**Then** 系统应：

1. 枚举所有正在运行的进程
2. 检查是否有进程路径包含"Antigravity.app"
3. 如果找到则返回 `true`，否则返回 `false`

#### Scenario: 在 Windows 上检测正在运行的 Antigravity 进程

**Given** 系统是 Windows
**When** 进程检测运行
**Then** 系统应：

1. 枚举所有正在运行的进程
2. 检查是否有进程名称为"Antigravity.exe"或路径包含"antigravity"
3. 排除名称中包含"manager"的进程（避免检测到本应用）
4. 如果找到则返回 `true`，否则返回 `false`

#### Scenario: 在 Linux 上检测正在运行的 Antigravity 进程

**Given** 系统是 Linux
**When** 进程检测运行
**Then** 系统应：

1. 枚举所有正在运行的进程
2. 检查是否有进程名称为"antigravity"或路径包含"antigravity"
3. 如果找到则返回 `true`，否则返回 `false`

***

### Requirement: 系统必须优雅地关闭 Antigravity 应用程序

系统应优雅地关闭 Antigravity 应用程序以保护数据完整性。

#### Scenario: 在 macOS 上优雅关闭

**Given** Antigravity 在 macOS 上运行
**When** 发起关闭
**Then** 系统应：

1. 执行 AppleScript：`tell application "Antigravity" to quit`
2. 等待最多 2 秒让应用程序响应
3. 检查进程是否已退出
4. 如果仍在运行则继续强制终止

#### Scenario: 在 Windows 上优雅关闭

**Given** Antigravity 在 Windows 上运行
**When** 发起关闭
**Then** 系统应：

1. 执行 `taskkill /IM Antigravity.exe /T`（不带 /F 标志）
2. 等待最多 2 秒让应用程序响应
3. 检查进程是否已退出
4. 如果仍在运行则继续强制终止

#### Scenario: 在 Linux 上优雅关闭

**Given** Antigravity 在 Linux 上运行
**When** 发起关闭
**Then** 系统应：

1. 向进程发送 SIGTERM 信号
2. 等待最多 10 秒让进程退出
3. 如果仍在运行则继续强制终止

***

### Requirement: 系统必须强制终止无响应的进程

系统应将强制终止 Antigravity 应用程序作为最后手段。

#### Scenario: 超时后强制终止

**Given** 优雅关闭已失败
**And** 超时期限（10 秒）已过
**When** 发起强制终止
**Then** 系统应：

1. 向进程发送 SIGKILL 信号（或在 Windows 上使用 `taskkill /F`）
2. 等待最多 1 秒确认
3. 如果进程已退出则返回成功
4. 如果进程仍存在则返回失败

#### Scenario: 多个 Antigravity 进程

**Given** 多个 Antigravity 进程正在运行
**When** 发起关闭
**Then** 系统应终止所有 Antigravity 进程

***

### Requirement: 系统必须启动 Antigravity 应用程序

系统应使用最可靠的方法启动 Antigravity 应用程序。

#### Scenario: 通过 URI 协议启动

**Given** Antigravity URI 协议已注册
**When** 发起启动
**Then** 系统应：

1. 打开 URI `antigravity://oauth-success`
2. 如果命令执行无错误则返回成功
3. 如果 URI 失败则回退到可执行文件路径方法

#### Scenario: 在 macOS 上通过可执行文件路径启动

**Given** URI 协议方法失败或被禁用
**When** 在 macOS 上发起启动
**Then** 系统应执行 `open -a Antigravity`

#### Scenario: 在 Windows 上通过可执行文件路径启动

**Given** URI 协议方法失败或被禁用
**When** 在 Windows 上发起启动
**Then** 系统应：

1. 在常见安装路径定位 Antigravity.exe 文件
2. 直接执行可执行文件
3. 如果未找到可执行文件则返回错误

#### Scenario: 在 Linux 上通过可执行文件路径启动

**Given** URI 协议方法失败或被禁用
**When** 在 Linux 上发起启动
**Then** 系统应执行 `antigravity` 命令

***

### Requirement: 系统必须实时监控进程状态

系统应持续监控 Antigravity 进程状态并更新 UI。

#### Scenario: 实时状态更新

**Given** 应用程序正在运行
**When** 状态监视器处于活动状态
**Then** 系统应：

1. 每 2 秒检查一次进程状态
2. 使用当前状态更新状态栏 UI
3. 根据运行状态更改状态栏颜色和图标
4. 继续监控直到应用程序关闭

#### Scenario: 状态栏交互

**Given** 状态栏已显示
**When** 用户点击状态栏
**Then** 系统应：

1. 如果未运行则启动 Antigravity
2. 如果正在运行则停止 Antigravity
3. 更新 UI 以反映新状态
