import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { getLocalizedErrorMessage } from '@/shared/utils/errorMessages';

const STORAGE_NOT_FOUND_MESSAGE =
  'Antigravity storage.json was not found. Open the target Antigravity app and sign in once, then try switching again.';

function createT(): TFunction {
  return ((key: string, options?: { defaultValue?: string }) => {
    const messages: Record<string, string> = {
      'error.antigravityStorageJsonNotFound': STORAGE_NOT_FOUND_MESSAGE,
    };

    return messages[key] ?? options?.defaultValue ?? key;
  }) as unknown as TFunction;
}

describe('getLocalizedErrorMessage', () => {
  it('explains missing Antigravity storage.json switch failures', () => {
    const message = getLocalizedErrorMessage(
      new Error('Switch failed: storage_json_not_found'),
      createT(),
    );

    expect(message).toBe(STORAGE_NOT_FOUND_MESSAGE);
  });

  it('explains missing Antigravity storage.json from object-shaped errors', () => {
    const message = getLocalizedErrorMessage(
      { message: 'Switch failed: storage_json_not_found' },
      createT(),
    );

    expect(message).toBe(STORAGE_NOT_FOUND_MESSAGE);
  });
});
