import { describe, it, expect, vi } from "vitest";
import {
  getAppDataDir,
  getAntigravityDbPath,
  getAntigravityExecutablePath,
} from "../../utils/paths";
import path from "path";
import os from "os";

describe("Path Utilities", () => {
  it("should get correct AppData directory", () => {
    const appData = getAppDataDir();
    expect(appData).toBeDefined();
    expect(appData.length).toBeGreaterThan(0);
  });

  it("should get correct DB path", () => {
    const dbPath = getAntigravityDbPath();
    expect(dbPath).toContain("state.vscdb");
  });

  it("should get correct executable path", () => {
    const execPath = getAntigravityExecutablePath();
    if (process.platform === "linux") {
      expect(execPath).toBe("/usr/share/antigravity/antigravity");
    } else if (process.platform === "darwin") {
      expect(execPath).toBe(
        "/Applications/Antigravity.app/Contents/MacOS/Antigravity",
      );
    }
    // Windows path depends on env vars, harder to test strictly without mocking
  });
});
