import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadAccountIndex,
  saveAccountIndex,
} from '@/modules/account/persistence/account-index-store';

describe('account index store', () => {
  let tempDir: string;
  let indexPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-account-index-'));
    indexPath = path.join(tempDir, 'accounts.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an empty index only when the file does not exist', () => {
    expect(loadAccountIndex(indexPath)).toEqual({});
  });

  it('fails closed when an existing account index is malformed', () => {
    const malformed = '{"account-a":';
    fs.writeFileSync(indexPath, malformed, 'utf-8');

    expect(() => loadAccountIndex(indexPath)).toThrow();
    expect(fs.readFileSync(indexPath, 'utf-8')).toBe(malformed);
  });

  it('replaces the index through a temporary file', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync');

    saveAccountIndex(indexPath, {});

    expect(writeSpy).toHaveBeenCalled();
    expect(String(writeSpy.mock.calls[0][0])).not.toBe(indexPath);
    expect(loadAccountIndex(indexPath)).toEqual({});
    expect(fs.readdirSync(tempDir)).toEqual(['accounts.json']);
  });

  it('preserves the existing index when the temporary write fails', () => {
    const original = '{"existing":{"id":"existing"}}\n';
    fs.writeFileSync(indexPath, original, 'utf-8');

    vi.spyOn(fs, 'writeFileSync').mockImplementation((file) => {
      if (String(file).startsWith(`${indexPath}.tmp-`)) {
        throw new Error('disk full');
      }
      throw new Error(`unexpected write target: ${String(file)}`);
    });

    expect(() => saveAccountIndex(indexPath, {})).toThrow('disk full');
    expect(fs.readFileSync(indexPath, 'utf-8')).toBe(original);
    expect(fs.readdirSync(tempDir)).toEqual(['accounts.json']);
  });
});
