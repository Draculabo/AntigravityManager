# 规格：本地化

## ADDED Requirements

### Requirement: 自动语言检测

应用在首次启动时 MUST 自动检测用户的系统语言并设置相应的界面语言。

#### Scenario: 系统语言为中文

Given 用户首次打开应用
And 用户的系统语言设置为中文 (zh-CN)
And 本地存储中没有保存语言偏好
When 应用加载时
Then 界面应该显示为简体中文 (`zh-CN`)

#### Scenario: 系统语言为其他（非中文）

Given 用户首次打开应用
And 用户的系统语言设置为法语 (fr)
And 本地存储中没有保存语言偏好
When 应用加载时
Then 界面应该回退显示为英语 (`en`)

### Requirement: 语言切换

用户 MUST 能够在支持的语言之间切换，且手动选择 MUST 覆盖自动检测。

#### Scenario: 切换语言

Given 用户在设置页面
When 用户从语言下拉菜单中选择 "English"
Then 界面应该立即切换为英语
And 偏好应该保存到本地存储

### Requirement: 持久化

用户的手动语言偏好 MUST 在会话之间持久化，并优先于系统语言。

#### Scenario: 持久化语言偏好

Given 用户已手动选择 "English" 作为首选语言
And 用户的系统语言设置为中文
When 用户重启应用
Then 界面应该显示为英语（尊重用户选择）

## MODIFIED Requirements

### Requirement: i18n 配置更新

i18n 配置 MUST 更新以支持语言检测插件。

#### Scenario: i18n 配置

`src/localization/i18n.ts` 文件必须更新为：

1. 集成 `i18next-browser-languagedetector`。
2. 配置检测顺序：`['localStorage', 'navigator']`。
3. 包含 `zh-CN` 资源对象。
