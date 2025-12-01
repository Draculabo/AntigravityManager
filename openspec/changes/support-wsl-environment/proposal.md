# Change: Support WSL Environment

## Summary

Enable Antigravity Manager running in WSL (Windows Subsystem for Linux) to manage the Antigravity application installed on the Windows host.

## Motivation

Users running the manager in a WSL development environment need to interact with the actual Antigravity instance running on Windows, as Antigravity is a Windows application.

## Proposed Changes

### 1. Path Resolution (`src/utils/paths.ts`)

* Implement `isWsl()` utility function.
* In `getAppDataDir()`: If WSL, return the Windows AppData path (e.g., `/mnt/c/Users/<User>/AppData/Roaming/Antigravity`).
* In `getAntigravityExecutablePath()`: If WSL, return the Windows executable path (e.g., `/mnt/c/Users/<User>/AppData/Local/Programs/Antigravity/Antigravity.exe`).
* **Challenge:** Determining the correct Windows username.
  * **Strategy:** Assume Windows username matches WSL username, or scan `/mnt/c/Users` for a likely candidate (excluding Public, Default, etc.).

### 2. Process Management (`src/ipc/process/handler.ts`)

* In `isProcessRunning()`: If WSL, execute `tasklist.exe` (via `/mnt/c/Windows/System32/tasklist.exe`) to check for `Antigravity.exe`.
* In `startAntigravity()`: If WSL, execute the Windows executable directly.
* In `closeAntigravity()`: If WSL, use `taskkill.exe` (via `/mnt/c/Windows/System32/taskkill.exe`).

## Acceptance Criteria

* \[ ] Application detects it is running in WSL.
* \[ ] Database file is correctly located on the Windows file system.
* \[ ] "Start" button successfully launches Antigravity on Windows.
* \[ ] "Stop" button successfully terminates Antigravity on Windows.
* \[ ] Process status (Running/Stopped) is correctly reflected in the UI.
