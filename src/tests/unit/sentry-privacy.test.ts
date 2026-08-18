import { describe, expect, it } from 'vitest';
import {
  redactLocalUserPaths,
  redactSentryEventLocalPaths,
} from '@/shared/observability/sentryPrivacy';

describe('Sentry local path redaction', () => {
  it('redacts Windows, macOS, and Linux user names from local paths', () => {
    expect(redactLocalUserPaths('C:\\Users\\alice\\AppData\\Local\\app.log')).toBe(
      'C:\\Users\\***\\AppData\\Local\\app.log',
    );
    expect(redactLocalUserPaths('/Users/bob/Library/Application Support/app.log')).toBe(
      '/Users/***/Library/Application Support/app.log',
    );
    expect(redactLocalUserPaths('/home/carol/.config/app.log')).toBe('/home/***/.config/app.log');
  });

  it('redacts local paths across exception, context, and extra event fields', () => {
    const event = {
      exception: {
        values: [
          {
            value: 'Failed at C:\\Users\\alice\\AppData\\Local\\Antigravity\\state.db',
            stacktrace: {
              frames: [{ filename: 'C:\\Users\\alice\\project\\src\\main.ts' }],
            },
          },
        ],
      },
      contexts: {
        recent_logs: {
          entries: [{ message: 'preload=/Users/bob/project/preload.js' }],
        },
      },
      extra: {
        log_message: 'config=/home/carol/.config/antigravity/settings.json',
      },
    };

    redactSentryEventLocalPaths(event);

    expect(event.exception.values[0].value).toContain('C:\\Users\\***\\AppData');
    expect(event.exception.values[0].stacktrace.frames[0].filename).toBe(
      'C:\\Users\\***\\project\\src\\main.ts',
    );
    expect(event.contexts.recent_logs.entries[0].message).toBe(
      'preload=/Users/***/project/preload.js',
    );
    expect(event.extra.log_message).toBe(
      'config=/home/***/.config/antigravity/settings.json',
    );
  });

  it('leaves unrelated strings unchanged', () => {
    expect(redactLocalUserPaths('https://example.com/Users/alice')).toBe(
      'https://example.com/Users/alice',
    );
  });
});
