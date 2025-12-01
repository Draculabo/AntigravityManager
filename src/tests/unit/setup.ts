import '@testing-library/jest-dom';
import * as matchers from '@testing-library/jest-dom/matchers';
import { expect, vi } from 'vitest';

expect.extend(matchers);

// Mock window and localStorage for Node environment
if (typeof window === 'undefined') {
  global.window = {
    matchMedia: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated
      removeListener: vi.fn(), // deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
    localStorage: {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      length: 0,
      key: vi.fn(),
    },
    postMessage: vi.fn(),
  } as any;

  global.localStorage = window.localStorage;
}

// Ensure HOME is defined for path utils
if (!process.env.HOME) {
  process.env.HOME = '/tmp/test-home';
}
if (!process.env.APPDATA) {
  process.env.APPDATA = '/tmp/test-appdata';
}

// Mock child_process if not already mocked (though individual tests should mock it)
// But some imports might trigger it early.
