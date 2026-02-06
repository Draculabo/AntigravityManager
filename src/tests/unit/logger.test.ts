import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../utils/logger';
import fs from 'fs';
import path from 'path';

vi.mock('../../utils/paths', async () => {
  const path = await import('path');
  return {
    getAgentDir: vi.fn(() => path.join(process.cwd(), 'temp_test_logs')),
  };
});

describe('Logger Utilities', () => {
  const testLogDir = path.join(process.cwd(), 'temp_test_logs');

  const getLatestLogFile = () => {
    const files = fs
      .readdirSync(testLogDir)
      .filter((file) => /^app-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(file))
      .sort();

    if (files.length === 0) {
      return null;
    }

    return path.join(testLogDir, files[files.length - 1]);
  };

  const waitForLogContains = async (text: string) => {
    for (let i = 0; i < 20; i++) {
      const filePath = getLatestLogFile();
      if (filePath && fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.includes(text)) {
          return filePath;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return null;
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    if (fs.existsSync(testLogDir)) {
      fs.rmSync(testLogDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testLogDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testLogDir)) {
      fs.rmSync(testLogDir, { recursive: true, force: true });
    }
  });

  it('should create rotated log file', async () => {
    const message = 'Test message';
    logger.info(message);
    const filePath = await waitForLogContains(message);
    expect(filePath).not.toBeNull();
    expect(fs.existsSync(filePath as string)).toBe(true);
  });

  it('should write formatted message to file', async () => {
    const message = 'Test info message';
    logger.info(message);
    const filePath = await waitForLogContains(message);
    expect(filePath).not.toBeNull();
    const content = fs.readFileSync(filePath as string, 'utf-8');
    expect(content).toContain('[INFO]');
    expect(content).toContain(message);
  });

  it('should log error messages', async () => {
    const message = 'Test error message';
    logger.error(message);
    const filePath = await waitForLogContains(message);
    expect(filePath).not.toBeNull();
    const content = fs.readFileSync(filePath as string, 'utf-8');
    expect(content).toContain('[ERROR]');
    expect(content).toContain(message);
  });
});
