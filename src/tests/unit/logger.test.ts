import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { logger } from "../../utils/logger";
import fs from "fs";
import path from "path";

vi.mock("../../utils/paths", async () => {
  const path = await import("path");
  return {
    getAgentDir: vi.fn(() => path.join(process.cwd(), "temp_test_logs")),
  };
});

describe("Logger Utilities", () => {
  const testLogDir = path.join(process.cwd(), "temp_test_logs");
  const testLogFile = path.join(testLogDir, "app.log");

  beforeEach(() => {
    console.log("Test Log Dir:", testLogDir);
    if (fs.existsSync(testLogDir)) {
      fs.rmSync(testLogDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testLogDir, { recursive: true });
    console.log("Dir created:", fs.existsSync(testLogDir));
  });

  afterEach(() => {
    if (fs.existsSync(testLogDir)) {
      fs.rmSync(testLogDir, { recursive: true, force: true });
    }
  });

  it("should create log file if it does not exist", () => {
    logger.info("Test message");
    expect(fs.existsSync(testLogFile)).toBe(true);
  });

  it("should write formatted message to file", () => {
    const message = "Test info message";
    logger.info(message);
    const content = fs.readFileSync(testLogFile, "utf-8");
    expect(content).toContain("[INFO]");
    expect(content).toContain(message);
  });

  it("should log error messages", () => {
    const message = "Test error message";
    logger.error(message);
    const content = fs.readFileSync(testLogFile, "utf-8");
    expect(content).toContain("[ERROR]");
    expect(content).toContain(message);
  });
});
