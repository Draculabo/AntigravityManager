import fs from 'fs';
import path from 'path';

import type { Account } from '@/modules/account/types';
import { logger } from '@/shared/logging/logger';

type AccountIndex = Record<string, Account>;

export function loadAccountIndex(filePath: string): AccountIndex {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as AccountIndex;
  } catch (error) {
    logger.error('Failed to load accounts index', error);
    throw error;
  }
}

export function saveAccountIndex(filePath: string, accounts: AccountIndex): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const content = `${JSON.stringify(accounts, null, 2)}\n`;

  try {
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (cleanupError) {
        logger.warn('Failed to clean up temporary accounts index', cleanupError);
      }
    }
    logger.error('Failed to save accounts index', error);
    throw error;
  }
}
