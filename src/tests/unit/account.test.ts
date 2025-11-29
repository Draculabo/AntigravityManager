import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  listAccountsData,
  addAccountSnapshot,
  switchAccount,
  deleteAccount,
} from "../../ipc/account/handler";
import fs from "fs";
import path from "path";

// Mock dependencies
vi.mock("../../utils/paths", async () => {
  const path = await import("path");
  const agentDir = path.join(process.cwd(), "temp_test_agent");
  return {
    getAgentDir: vi.fn(() => agentDir),
    getAccountsFilePath: vi.fn(() => path.join(agentDir, "accounts.json")),
    getBackupsDir: vi.fn(() => path.join(agentDir, "backups")),
    getAntigravityDbPath: vi.fn(() => path.join(agentDir, "state.vscdb")),
    getAntigravityExecutablePath: vi.fn(() => "mock_exec_path"),
  };
});

vi.mock("../../ipc/database/handler", () => ({
  getCurrentAccountInfo: vi.fn(() => ({
    email: "test@example.com",
    name: "Test User",
    isAuthenticated: true,
  })),
  backupAccount: vi.fn((account) => ({ version: "1.0", account, data: {} })),
  restoreAccount: vi.fn(),
  getDatabaseConnection: vi.fn(),
}));

vi.mock("../../ipc/process/handler", () => ({
  closeAntigravity: vi.fn(),
  startAntigravity: vi.fn(),
  isProcessRunning: vi.fn(() => Promise.resolve(false)),
}));

describe("Account Handler", () => {
  const testAgentDir = path.join(process.cwd(), "temp_test_agent");

  beforeEach(() => {
    if (fs.existsSync(testAgentDir)) {
      fs.rmSync(testAgentDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testAgentDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testAgentDir)) {
      fs.rmSync(testAgentDir, { recursive: true, force: true });
    }
  });

  it("should add account snapshot", async () => {
    const account = await addAccountSnapshot();
    expect(account.email).toBe("test@example.com");

    const accounts = await listAccountsData();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe("test@example.com");
  });

  it("should switch account", async () => {
    const account = await addAccountSnapshot();
    await switchAccount(account.id);
    // Mocks should be called, verified by implementation logic not throwing
  });

  it("should delete account", async () => {
    const account = await addAccountSnapshot();
    await deleteAccount(account.id);

    const accounts = await listAccountsData();
    expect(accounts).toHaveLength(0);
  });
});
