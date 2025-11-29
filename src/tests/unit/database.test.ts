import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getDatabaseConnection,
  getCurrentAccountInfo,
  backupAccount,
  restoreAccount,
} from "../../ipc/database/handler";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// Mock paths to use a temp DB
const tempDbPath = path.join(process.cwd(), "temp_test.vscdb");

vi.mock("../../utils/paths", async () => {
  const path = await import("path");
  const tempDbPath = path.join(process.cwd(), "temp_test.vscdb");
  return {
    getAntigravityDbPath: () => tempDbPath,
    getAgentDir: () => path.join(process.cwd(), "temp_test_agent"), // Mock for logger
  };
});

describe("Database Handler", () => {
  beforeEach(() => {
    // Create a fresh DB for each test
    const db = new Database(tempDbPath);
    db.exec(
      "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)",
    );
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "antigravityAuthStatus",
      JSON.stringify({
        user: { email: "test@example.com", name: "Test User" },
      }),
    );
    db.close();
  });

  afterEach(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  it("should connect to database", () => {
    const db = getDatabaseConnection();
    expect(db).toBeDefined();
    db.close();
  });

  it("should get current account info", () => {
    const info = getCurrentAccountInfo();
    expect(info.email).toBe("test@example.com");
    expect(info.name).toBe("Test User");
    expect(info.isAuthenticated).toBe(true);
  });

  it("should backup account", () => {
    const account = {
      id: "123",
      name: "Test User",
      email: "test@example.com",
      created_at: new Date().toISOString(),
      last_used: new Date().toISOString(),
    };
    const backup = backupAccount(account);
    expect(backup.account).toEqual(account);
    expect(backup.data["antigravityAuthStatus"]).toBeDefined();
  });

  it("should restore account", () => {
    const backup = {
      version: "1.0",
      account: {
        id: "123",
        name: "Restored User",
        email: "restored@example.com",
        created_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
      },
      data: {
        antigravityAuthStatus: JSON.stringify({
          user: { email: "restored@example.com" },
        }),
        newKey: "newValue",
      },
    };

    restoreAccount(backup);

    const db = new Database(tempDbPath);
    const row = db
      .prepare(
        "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'",
      )
      .get() as { value: string };
    const value = JSON.parse(row.value);
    expect(value.user.email).toBe("restored@example.com");

    const newRow = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'newKey'")
      .get() as { value: string };
    expect(newRow.value).toBe("newValue"); // JSON stringified
    db.close();
  });
});
