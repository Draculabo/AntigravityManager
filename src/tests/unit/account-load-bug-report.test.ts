import { describe, expect, it } from 'vitest';
import { buildAccountLoadBugReport } from '@/modules/cloud-account/utils/account-load-bug-report';

const environment = {
  appVersion: '0.17.1',
  platform: 'linux',
  osVersion: 'Ubuntu 24.04 (6.8.0)',
  architecture: 'x64',
  electronVersion: '37.2.0',
  nodeVersion: '22.16.0',
};

describe('account-load bug report', () => {
  it('includes the environment and backend stack rather than the transport stack', () => {
    const report = buildAccountLoadBugReport(environment, {
      message: 'IPC failed',
      stack: 'Transport stack',
      data: {
        requestPath: '["cloud","listCloudAccounts"]',
        backendCode: 'SERVICE_UNAVAILABLE',
        backendMessage: 'Account storage is unavailable',
        backendStack:
          'Error: Account storage is unavailable\n    at readAccounts (accounts.ts:42:1)',
      },
    });
    expect(report).toBe(
      '## Environment\n\n' +
        '- **OS**: linux — Ubuntu 24.04 (6.8.0)\n' +
        '- **Architecture**: x64\n' +
        '- **App Version**: 0.17.1\n' +
        '- **Electron Version**: 37.2.0\n' +
        '- **Node.js Version**: 22.16.0\n\n' +
        '## Additional Context\n\n' +
        'Cloud accounts could not be loaded. Error details:\n\n' +
        '    Request path: ["cloud","listCloudAccounts"]\n    \n' +
        '    Backend code: SERVICE_UNAVAILABLE\n    \n' +
        '    Backend message: Account storage is unavailable\n    \n' +
        '    Error: Account storage is unavailable\n        at readAccounts (accounts.ts:42:1)',
    );
  });

  it('masks credentials, emails and user directories in error details', () => {
    const report = buildAccountLoadBugReport(environment, {
      message: 'Authorization: Bearer synthetic-bearer-secret',
      stack: [
        'access_token="synthetic-access-secret" refresh_token=synthetic-refresh-secret',
        'https://localhost/callback?code=synthetic-auth-code&key=synthetic-api-key',
        'https://synthetic-user:synthetic-password@localhost/request',
        'https://synthetic-user:synthetic-password@proxy.example.invalid/request',
        'Account private@example.invalid',
        'at C:\\Users\\PrivateUser\\app\\accounts.ts:42:1',
        'at /home/private-user/app/accounts.ts:42:1',
        'at /Users/private-user/app/accounts.ts:42:1',
      ].join('\n'),
    });
    expect(report).not.toMatch(/synthetic-|private@example|PrivateUser|private-user/);
    expect(report).toContain('Authorization: [REDACTED] [REDACTED]');
    expect(report).toContain('?code=[REDACTED]&key=[REDACTED]');
    expect(report).toContain('https://[REDACTED]@localhost/request');
    expect(report).toContain('C:\\Users\\***\\app\\accounts.ts:42:1');
    expect(report).toContain('/home/***/app/accounts.ts:42:1');
    expect(report).toContain('/Users/***/app/accounts.ts:42:1');
  });

  it('keeps Markdown-looking errors inside the copied code block', () => {
    expect(buildAccountLoadBugReport(environment, '```\n## Unexpected heading')).toContain(
      '    Message: ```\n    ## Unexpected heading',
    );
  });
});
