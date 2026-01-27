---
name: antigravity-manager
description: Comprehensive guide to Antigravity Manager architecture, workflows, and development. Use this to understand how to work on the project.
---

# Antigravity Manager Developer Guide

## 🏗️ Architecture Overview

Antigravity Manager is a hybrid Desktop Application built with Electron, React, and NestJS. It follows a modular architecture where the frontend (Renderer) communicates with the backend (Main) via type-safe IPC (ORPC).

```mermaid
graph TD
    User[User Interface] -->|React/Vite| Renderer[Renderer Process]
    Renderer -->|ORPC Client| IPC[IPC Layer]
    IPC -->|ORPC Router| Main[Main Process]
    Main -->|Bootstraps| Server[NestJS Server]
    Main -->|Calls| Services[Service Layer]
    Services -->|Read/Write| DB[(SQLite Database)]
    Services -->|HTTP| Cloud[Cloud APIs (Google/Anthropic)]
```

### Key Technologies
- **Frontend**: React 19, TailwindCSS v4, TanStack Router, TanStack Query.
- **Backend**: Electron (Main), NestJS (Core Logic), Better-SQLite3 (Data).
- **Communication**: ORPC (Type-safe IPC wrapper around Electron IPC).
- **Build**: Electron Forge + Vite.

## 📂 Directory Structure

- `src/main.ts`: Electron Main Process entry point.
- `src/preload.ts`: Bridge between Main and Renderer.
- `src/renderer.tsx`: React App entry point.
- `src/components/`: Reusable React UI components (Radix UI based).
- `src/ipc/`: IPC Routers and Handlers (Domain logic).
    - `router.ts`: Main ORPC router definition.
    - `account/`, `cloud/`, `database/`: Domain-specific handlers.
- `src/server/`: NestJS application modules (proxies/gateways).
- `src/services/`: Core business logic (framework agnostic).
    - `GoogleAPIService.ts`: Gemini/Cloud interactions.
    - `AutoSwitchService.ts`: Account rotation logic.
- `src/routes/`: Frontend routing definitions (File-based).

## 🚀 Development Workflow

### Prerequisites
- Node.js 18+
- npm (Project uses `package-lock.json`)

### Common Commands
- **Start Dev Server**: `npm start`
- **Lint Code**: `npm run lint`
- **Unit Test**: `npm run test:unit`
- **E2E Test**: `npm run test:e2e`
- **Build Production**: `npm run make`

## 🧠 Core Concepts

### IPC Communication (ORPC)
The project uses `orpc` for type-safe communication.
- **Define**: Create a router in `src/ipc/router.ts` with Zod schemas.
- **Implement**: Add logic in handlers (e.g., `src/ipc/account/handler.ts`).
- **Call**: Use the generated client in React components.

### Database Access
Data is stored in a local SQLite file (`test.db` in dev, user data in prod).
- Use `Better-SQLite3` for direct access.
- Logic should be encapsulated in `src/services` or `src/ipc`.

### Account Management
- Accounts are added via OAuth (Google/Claude).
- `GoogleAPIService` handles token exchange and refreshing.
- `AutoSwitchService` monitors usage and switches active accounts automatically.

## ⚠️ Critical Rules
1. **Type Safety**: strict TypeScript usage; Zod for runtime validation.
2. **Components**: Use `src/components/ui` (Radix primitives) for consistency.
3. **Async**: Handle all IPC/DB calls asynchronously with try/catch.
4. **Security**: Never commit secrets. API keys are user-provided or encrypted locally.
