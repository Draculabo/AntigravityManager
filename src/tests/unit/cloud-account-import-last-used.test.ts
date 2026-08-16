import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const handlerPath = path.join(
  process.cwd(),
  'src/modules/cloud-account/ipc/handler.ts',
);

function readImportAccountBlocks(): {
  existingAccountBlock: string;
  newAccountBlock: string;
} {
  const source = fs.readFileSync(handlerPath, 'utf8');
  const existingStart = source.indexOf('const updatedAccount: CloudAccount = {');
  const existingEnd = source.indexOf(
    'await CloudAccountRepo.addAccount(updatedAccount);',
    existingStart,
  );
  const newStart = source.indexOf('const newAccount: CloudAccount = {', existingEnd);
  const newEnd = source.indexOf('await CloudAccountRepo.addAccount(newAccount);', newStart);

  expect(existingStart).toBeGreaterThanOrEqual(0);
  expect(existingEnd).toBeGreaterThan(existingStart);
  expect(newStart).toBeGreaterThan(existingEnd);
  expect(newEnd).toBeGreaterThan(newStart);

  return {
    existingAccountBlock: source.slice(existingStart, existingEnd),
    newAccountBlock: source.slice(newStart, newEnd),
  };
}

describe('cloud account import last-used semantics', () => {
  it('preserves usage recency for existing accounts while initializing new accounts', () => {
    const { existingAccountBlock, newAccountBlock } = readImportAccountBlocks();

    expect(existingAccountBlock).toContain('...existing');
    expect(existingAccountBlock).not.toMatch(/last_used:\s*now/);
    expect(newAccountBlock).toMatch(/last_used:\s*now/);
  });
});
