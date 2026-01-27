<!-- OPENSPEC:START -->

# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:

- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:

- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# 用户指南

本文是 AI 助手在本仓库工作的用户级指南。中文为主、工具与脚本偏好统一、并纳入你补充的技术栈与开发注意事项。

## 💬 沟通约定

- **语言**: 对话、待办、代码相关内容（注释、UI 文案、提交信息、PR 描述等）统一使用中文。
- **结论先行**: 回答先给出核心结论/摘要，再补充细节。
- **引用**: 引用具体代码时，务必给出完整文件路径（如 `src/main.ts:42`）。

## 💻 运行环境与工具

- **Runtime**: Node.js (Electron 环境)
- **Node**: 建议 Node.js 20+
- **包管理器**: `npm` (本项目包含 package-lock.json，强制使用 npm)
- **构建工具**: Electron Forge + Vite
- **终端环境**: Windows (PowerShell) / 可安全使用 VSCode MCP 工具

## 🧩 技术栈总览 (Tech Stack)

- **Frontend**:
  - React 19, TypeScript
  - Tailwind CSS v4, `clsx`, `tailwind-merge`, `tailwindcss-animate`
  - Radix UI (Primitives), Lucide React (Icons), Sonner (Toast)
  - TanStack Router (Routing), TanStack Query (State Management)
  - Components: 模块化设计，`src/components`
- **Backend (Electron Main/Server)**:
  - Electron (Main/Preload/Renderer 架构)
  - NestJS (用于内部代理/网关服务，由 Main Process 启动)
  - Better-SQLite3 (本地数据库), Drizzle ORM (如果后续引入) / Raw SQL
  - ORPC (Type-safe RPC)
  - Zod (Validation)
- **Testing**:
  - Vitest (Unit/Integration Tests)
  - Playwright (E2E Tests)

## 📁 目录结构

```plaintext
.
├─ src/
│  ├─ components/        # React UI 组件 (ui/ 存放基础组件)
│  ├─ hooks/             # Custom React Hooks
│  ├─ ipc/               # Electron IPC 处理逻辑 (Database, Config, etc.)
│  ├─ layouts/           # 页面布局组件
│  ├─ lib/               # 通用工具库
│  ├─ routes/            # TanStack Router 路由定义
│  ├─ server/            # NestJS 后端服务逻辑 (Gateway/Proxy)
│  ├─ services/          # 业务服务层
│  ├─ styles/            # 全局样式 (Tailwind class)
│  ├─ types/             # TypeScript 类型定义
│  ├─ utils/             # 通用工具函数
│  ├─ App.tsx            # React 应用入口
│  ├─ main.ts            # Electron 主进程入口
│  ├─ preload.ts         # Electron 预加载脚本
│  └─ renderer.ts        # Electron 渲染进程入口
├─ forge.config.ts       # Electron Forge 配置
└─ package.json
```

## 🧱 组件架构（Component Architecture）

- **模块化组件**: 每个组件使用独立目录，至少包含 `.tsx` 以及可能的样式或子组件。
- **共享能力**: 通用函数置于 `src/utils/`，底层通用封装置于 `src/lib/`。
- **服务层**: 统一在 `src/services/` 或 `src/ipc/` 中封装数据访问，前端仅依赖 IPC 或 RPC 调用。

## 📦 常用脚本 (Scripts)

所有命令使用 `npm` 执行：

- **开发 (Dev)**:
  - `npm start` - 启动 Electron 开发环境 (Electron Forge)
  - `npm run lint` - 运行 ESLint 检查
  - `npm run format` - 运行 Prettier 格式化检查

- **构建 (Build)**:
  - `npm run package` - 打包应用 (生成的只有应用包)
  - `npm run make` - 构建并生成分发安装包 (Make)
  - `npm run publish` - 发布应用

- **测试 (Test)**:
  - `npm test` - 运行 Vitest 单元测试
  - `npm run test:unit` - 同上
  - `npm run test:e2e` - 运行 Playwright 端到端测试
  - `npm run test:all` - 运行所有测试

### 运行单个测试 (Running Single Tests)

- 单元测试: `npm run test:unit path/to/test.test.ts`
- E2E 测试: `npm run test:e2e path/to/test.spec.ts`
- 类型检查: `npm run type-check`

## 🧪 开发注意事项（Development Notes）

- **Build**: 构建阶段忽略 TS/ESLint 错误（如有特定配置或 CI 要求，请以实际为准）。
- **DevTools**: 项目集成了 `code-inspector-plugin`，开发时支持从页面元素直接跳转代码（Shift+Click）。
- **React**: React Strict Mode 关闭。
- **NestJS**: 作为 Electron 子进程运行，日志输出在主进程控制台。

## �️ 安全与数据 (Security & Data)

- **安全**: 绝不提交密钥；敏感配置使用环境变量；验证所有用户输入；敏感数据加密存储。
- **数据库**: 使用 Better-SQLite3；所有操作封装在 Services 层；必须使用 Prepared Statements；独立测试 DB 操作。
- **国际化**: 使用 `react-i18next`；Key 使用 kebab-case；翻译文件存放在 `src/localization/`。

## �📝 代码规范 (Conventions)

- **文件命名**:
  - 组件: PascalCase (e.g., `Button.tsx`)
  - 工具/配置: camelCase 或 kebab-case
- **导入路径**: 使用 `@/` 别名指向 `src/` 目录。
- **类型安全**: 严禁使用 `any`，利用 Zod 和 TypeScript 确保全链路类型安全。
- **组件设计**:
  - 优先使用 Radix UI Primitives。
  - 样式使用 Tailwind Utility Classes，避免 CSS Modules (除非必要)。
- **API 通信**: 前端调用后端优先使用 ORPC 客户端或 IPC，确保类型推导。

### 命名约定 (Naming Specifics)

- **Functions/Variables**: camelCase (e.g., `handleClick`, `isCurrent`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `LOCAL_STORAGE_KEYS`)
- **Files**:
  - Services: `ServiceName.service.ts`
  - Types: `type-name.ts`

### 导入组织 (Import Organization)

```typescript
// 1. React 和核心库
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';

// 2. 外部依赖 (按字母顺序)
import { useTranslation } from 'react-i18next';
import { formatDistanceToNow } from 'date-fns';

// 3. 内部导入 (使用 @ 别名)
import { Account } from '@/types/account';
import { Card, CardContent } from '@/components/ui/card';
```

### 组件结构 (Component Structure)

```typescript
// 1. 导入
import React, { useState } from 'react';

// 2. 类型定义
interface ComponentProps { /* props */ }

// 3. 组件实现
export const Component: React.FC<ComponentProps> = ({ prop1 }) => {
  // 4. Hooks
  const { t } = useTranslation();
  // 5. Render
  return <div>{/* JSX */}</div>;
};
```

> 提交前请确保执行 `npm run lint` 和 `npm run format`。

## 📝 终端输出与引用规范

- 代码块优先，避免 Markdown 表格与 mermaid（Claude 代码块渲染更稳定）。
- 表格（如需）左对齐；中文字符等宽注意显示差异。

示例：

```plaintext
+------+---------+---------+
|  ID  |  Name   |  Role   |
+------+---------+---------+
|  1   |  Alice  |  Admin  |
|  2   |  Bob    |  User   |
+------+---------+---------+
```

### 引用规范（References）

- 外部资源：使用完整可点击链接（Issue、文档、API 参考）。
- 源码位置：使用完整文件路径（可附行号）。

示例：

```plaintext
- “resolveFilePath 负责该逻辑”
- “VSCode 在撤销操作上存在既知限制”

🔗 References:
- resolveFilePath: src/utils/workspace.ts:40
- VSCode undo limitation: https://github.com/microsoft/vscode/issues/77190
```

## 🏷️ Markdown 书写

- 代码块语言不要留空，无法确定时使用 `plaintext`。
- 标题后保留一行空行，便于渲染与阅读。

## 换行规范

return 等语句不要与其他语句在同一行，而是单独保持一行

## 💭 注释规范

- 必注释场景：复杂业务/算法、特殊行为、重要设计取舍、关键参考链接。
- 原则：
  - 注释“为什么”（Why），非“做了什么”（What）、非变更记录（Changelog）。
  - 修改代码时同步更新注释（过时注释比无注释更糟）。
  - 优先使用 JSDoc，复杂函数先给高层概览，函数体内按步骤（1、2、3…）标注关键过程。
  - 中英文之间适当空格，提升可读性；不要为删除的旧代码写注释。

“质量自检”问题：六个月后新同事看到这条注释能得到什么有用信息？若答案是“没有”，删掉它。

示例：

```typescript
/**
 * 处理支付请求，多步骤校验
 */
function processPayment(request: PaymentRequest) {
  // 1. 数据校验
  // 2. 风控评估（低/中/高差异处理）
  // 3. 网关调用
  // 4. 用户通知
}

export enum BudgetType {
  Free = 'free',
  /** ✅ 推荐使用 JSDoc，而不是行尾注释 */
  Package = 'package',
}
```

## 🛠️ 开发指南

### 通用原则

- 优先稳定与可维护性，其次再谈性能优化。
- 面对不确定性：明确假设、取舍与验证方案；先沟通再实施。
- 信任既定前置条件，避免对承诺不变量的过度防御；若出现冲突，更新方案而非额外兜底。
- 老代码重构保守推进，新功能实现可采用更现代方式。
- 避免过早优化：先以简单直接的实现达成功能，确需时再优化（避免先行加缓存/抖动或拆分成过多文件）。
- 对于 if，while 等条件、循环语句必须加上花括号，不能与return、break、continue 等语句同级。

### 错误处理 (Error Handling)

```typescript
// 异步操作使用 try-catch
try {
  const result = await someOperation();
  return result;
} catch (error) {
  console.error('Operation failed:', error);
  throw new Error('Failed to complete operation');
}

// 使用正确的错误类型
if (error instanceof Error) {
  /* 处理 Error 实例 */
}
```

### 新功能实现

- 代码应清晰、可读、可复用、有效率且可测试。
- 倾向选用成熟可靠的现代 API。

### 重构与修 Bug

- 倾向增量式改动；如需大重构，先就范围对齐再推进。
- 保持原结构与风格，避免过度抽象引入新风险。

### 开发生命周期（Checklist）

探索/规划：

- \[ ] 充分理解需求，分步思考与列计划（3–6 步）
- \[ ] 优先查阅文档与既有方案
- \[ ] 通过阅读实际代码验证想法
- \[ ] 形成 TODO 列表

实现/重构/修复：

- [ ] 阅读相关模板与周边代码，沿用既有模式
- [ ] Fail fast：对非法输入/状态抛错，尽早暴露问题
- [ ] 在约束内尽力提升前端交互与体验

验收/校验：

- \[ ] 通过测试或临时脚本验证实现
- \[ ] 多次增量修改后回看是否可合并为一次更连贯的修改
- \[ ] 运行质量检查
- \[ ] 更新相关文档

总结/输出：

- \[ ] 检查输出格式要求
- \[ ] 列出与原计划偏差与关键决策，便于人工复核
- \[ ] 提供优化建议
- \[ ] 在结尾提供完整引用链接

## 🔍 代码质量与 Lint

- 变量命名具描述性（如 `mutationObserver`、`button`、`element`），避免 `mo`、`btn`、`el`。
- 检查缺失的重要注释，并保持注释语言一致。
- 使用 VSCode MCP 诊断工具查看 TS/ESLint 报告并修复关键问题。
- 若新增/修改测试，需运行并修复测试后再提交。

## ⛔ 需要显式确认的操作

- 运行具有破坏性的命令
- 执行 `git commit`、`git push`
- 新建测试文件（先由维护者进行人工审核）

## 🔧 工具偏好与命令

包与脚本：

- `npm install` (或简写 `npm i`)

Shell：

- 在工作区根目录执行命令。
- 路径建议使用引号包裹。

Web 搜索：

- `WebSearch` 获取最新内容；不足时用 `mcp__SearXNG__search` 聚合搜索

文档/用法检索：

- `context7` 获取依赖的最新用法

VSCode MCP (如可用):

- `mcp__vscode-mcp__get_references` 辅助重构范围判定
- `mcp__vscode-mcp__rename_symbol` 安全重命名
- `mcp__vscode-mcp__get_symbol_lsp_info` 获取类型/签名/定义等信息

## 🚨 本地质量检查（可选流程）

在完成一组修改后并行执行三类检查，而非直接跑全量 lint：

```plaintext
Task(subagent_type: "quick-code-review", description: "Code review", prompt: "[change description]")
Task(subagent_type: "diagnostics", description: "Diagnostics", prompt: "[same as above]")
Task(subagent_type: "run-related-tests", description: "Run tests", prompt: "[same as above]")
```

change description 示例：

```plaintext
- Modified files: 相对路径列表
- Context: 需求/业务背景
```

流程：初检 → 修复关键问题 → 复检 → 迭代至关键问题清零。

注意：上述工具为只读分析，需自行修复；传入精确文件路径，避免用笼统目录。

<skills_system priority="1">

## Available Skills

<!-- SKILLS_TABLE_START -->
<usage>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills:

- Invoke: Bash("openskills read <skill-name>")
- The skill content will load with detailed instructions on how to complete the task
- Base directory provided in output for resolving bundled resources (references/, scripts/, assets/)

Usage notes:

- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already loaded in your context
- Each skill invocation is stateless
  </usage>

<available_skills>

<skill>
<name>algorithmic-art</name>
<description>Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration. Use this when users request creating art using code, generative art, algorithmic art, flow fields, or particle systems. Create original algorithmic art rather than copying existing artists' work to avoid copyright violations.</description>
<location>project</location>
</skill>

<skill>
<name>brand-guidelines</name>
<description>Applies Anthropic's official brand colors and typography to any sort of artifact that may benefit from having Anthropic's look-and-feel. Use it when brand colors or style guidelines, visual formatting, or company design standards apply.</description>
<location>project</location>
</skill>

<skill>
<name>canvas-design</name>
<description>Create beautiful visual art in .png and .pdf documents using design philosophy. You should use this skill when the user asks to create a poster, piece of art, design, or other static piece. Create original visual designs, never copying existing artists' work to avoid copyright violations.</description>
<location>project</location>
</skill>

<skill>
<name>doc-coauthoring</name>
<description>Guide users through a structured workflow for co-authoring documentation. Use when user wants to write documentation, proposals, technical specs, decision docs, or similar structured content. This workflow helps users efficiently transfer context, refine content through iteration, and verify the doc works for readers. Trigger when user mentions writing docs, creating proposals, drafting specs, or similar documentation tasks.</description>
<location>project</location>
</skill>

<skill>
<name>docx</name>
<description>"Comprehensive document creation, editing, and analysis with support for tracked changes, comments, formatting preservation, and text extraction. When Claude needs to work with professional documents (.docx files) for: (1) Creating new documents, (2) Modifying or editing content, (3) Working with tracked changes, (4) Adding comments, or any other document tasks"</description>
<location>project</location>
</skill>

<skill>
<name>frontend-design</name>
<description>Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when styling/beautifying any web UI). Generates creative, polished code and UI design that avoids generic AI aesthetics.</description>
<location>project</location>
</skill>

<skill>
<name>internal-comms</name>
<description>A set of resources to help me write all kinds of internal communications, using the formats that my company likes to use. Claude should use this skill whenever asked to write some sort of internal communications (status reports, leadership updates, 3P updates, company newsletters, FAQs, incident reports, project updates, etc.).</description>
<location>project</location>
</skill>

<skill>
<name>mcp-builder</name>
<description>Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. Use when building MCP servers to integrate external APIs or services, whether in Python (FastMCP) or Node/TypeScript (MCP SDK).</description>
<location>project</location>
</skill>

<skill>
<name>pdf</name>
<description>Comprehensive PDF manipulation toolkit for extracting text and tables, creating new PDFs, merging/splitting documents, and handling forms. When Claude needs to fill in a PDF form or programmatically process, generate, or analyze PDF documents at scale.</description>
<location>project</location>
</skill>

<skill>
<name>pptx</name>
<description>"Presentation creation, editing, and analysis. When Claude needs to work with presentations (.pptx files) for: (1) Creating new presentations, (2) Modifying or editing content, (3) Working with layouts, (4) Adding comments or speaker notes, or any other presentation tasks"</description>
<location>project</location>
</skill>

<skill>
<name>skill-creator</name>
<description>Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Claude's capabilities with specialized knowledge, workflows, or tool integrations.</description>
<location>project</location>
</skill>

<skill>
<name>slack-gif-creator</name>
<description>Knowledge and utilities for creating animated GIFs optimized for Slack. Provides constraints, validation tools, and animation concepts. Use when users request animated GIFs for Slack like "make me a GIF of X doing Y for Slack."</description>
<location>project</location>
</skill>

<skill>
<name>theme-factory</name>
<description>Toolkit for styling artifacts with a theme. These artifacts can be slides, docs, reportings, HTML landing pages, etc. There are 10 pre-set themes with colors/fonts that you can apply to any artifact that has been creating, or can generate a new theme on-the-fly.</description>
<location>project</location>
</skill>

<skill>
<name>web-artifacts-builder</name>
<description>Suite of tools for creating elaborate, multi-component claude.ai HTML artifacts using modern frontend web technologies (React, Tailwind CSS, shadcn/ui). Use for complex artifacts requiring state management, routing, or shadcn/ui components - not for simple single-file HTML/JSX artifacts.</description>
<location>project</location>
</skill>

<skill>
<name>webapp-testing</name>
<description>Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs.</description>
<location>project</location>
</skill>

<skill>
<name>xlsx</name>
<description>"Comprehensive spreadsheet creation, editing, and analysis with support for formulas, formatting, data analysis, and visualization. When Claude needs to work with spreadsheets (.xlsx, .xlsm, .csv, .tsv, etc) for: (1) Creating new spreadsheets with formulas and formatting, (2) Reading or analyzing data, (3) Modify existing spreadsheets while preserving formulas, (4) Data analysis and visualization in spreadsheets, or (5) Recalculating formulas"</description>
<location>project</location>
</skill>

</available_skills>

<!-- SKILLS_TABLE_END -->

</skills_system>
