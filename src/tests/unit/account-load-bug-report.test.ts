import { describe, expect, it } from 'vitest';
import { buildAccountLoadBugReport } from '@/modules/cloud-account/utils/account-load-bug-report';
import template from '../../../.github/ISSUE_TEMPLATE/bug_report.md?raw';

const environment = {
  appVersion: '0.17.1',
  platform: 'linux',
  osVersion: 'Ubuntu 24.04 (6.8.0)',
  architecture: 'x64',
  electronVersion: '37.2.0',
  nodeVersion: '22.16.0',
};

describe('account-load bug report', () => {
  it('preserves every issue-template section and both correlation references in the copied report', () => {
    const diagnosticId = '11111111-1111-4111-8111-111111111111';
    const eventId = 'a'.repeat(32);
    const report = buildAccountLoadBugReport(environment, {
      data: {
        diagnostic: {
          schemaVersion: 1,
          diagnosticId,
          operation: 'cloud-account-switch',
          stage: 'process-close',
          reason: 'process-close-failed',
          reporting: { state: 'captured', eventId },
        },
      },
    });
    expect(report.match(/^## .+$/gm)).toEqual(template.match(/^## .+$/gm));
    expect(report).toContain(`Diagnostic ID: ${diagnosticId}`);
    expect(report).toContain(`Sentry event ID: ${eventId}`);
    expect(report.indexOf('Diagnostic ID:')).toBeGreaterThan(
      report.indexOf('## Screenshots or Diagnostic Details'),
    );
    expect(report.indexOf('Diagnostic ID:')).toBeLessThan(report.indexOf('## Environment'));
  });
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
    expect(report).toMatchInlineSnapshot(`
      "<!-- Do not report security vulnerabilities here. Use https://github.com/Draculabo/AntigravityManager/security/advisories/new instead. -->

      ## Describe the Bug

      A clear and concise description of what the bug is.

      ## Steps To Reproduce

      1. Start from ...
      2. Perform ...
      3. Observe ...

      State whether the problem occurs every time. If a minimal example is needed, use synthetic data.

      ## Expected Behavior

      A clear and concise description of what you expected to happen.

      ## Actual Behavior

      What actually happened.

      ## Screenshots or Diagnostic Details

      Include the exact error text or diagnostic reference when available. Remove account names,
      email addresses, tokens, authorization headers and private paths from logs and screenshots.
      Do not attach account databases, full backups, environment files or raw credential documents.

          Request path: ["cloud","listCloudAccounts"]

          Backend code: SERVICE_UNAVAILABLE

          Backend message: Account storage is unavailable

          Error: Account storage is unavailable
              at readAccounts (accounts.ts:42:1)

      ## Environment

      - **App version**: 0.17.1
      - **Operating system and version**: linux — Ubuntu 24.04 (6.8.0)
      - **CPU architecture**: x64
      - **Installation source and package type**: [e.g., GitHub Release MSI, DMG, AppImage, or source checkout]
      - **Failure stage**: [installation, startup, or an action inside the app]
      - **Target client and version**: [if account switching or a coding tool is affected]

      - **Electron version**: 37.2.0
      - **Bundled Node.js version**: 22.16.0

      ### Source Development Only

      <!-- Packaged-app users can remove this section; Node.js and pnpm are not required to use the installed app. -->

      - **Git commit**:
      - **Node.js and pnpm versions**:
      - **Command run and relevant output**:

      ## Additional Context

      Add any other context about the problem here.

      Cloud accounts could not be loaded. Error details:
      "
    `);
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
