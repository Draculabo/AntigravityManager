import { setTimeout as delay } from 'node:timers/promises';
import type { ManagementClient } from '@/core/management/client';
import { DesktopOAuthLoginError } from '@/modules/cloud-account/services/desktop-oauth-login.error';
import { GoogleLoginOperation } from '@/modules/cloud-account/services/google-login-operation';
import { readFinalizedOperationDiagnostic } from '@/shared/observability/operationDiagnostic';
import type { CliOutput } from './app';
import type { ServiceLauncher } from './service-launcher';

/** The CLI coordinates identity; callback handling and account writes remain in the core owner. */
export async function loginGoogleAccount(
  oauth: Pick<ManagementClient, 'startOAuth' | 'oauthStatus'> | undefined,
  startOwner: () => ReturnType<ServiceLauncher['start']>,
  output: CliOutput,
): Promise<void> {
  const operation = new GoogleLoginOperation();
  try {
    if (!oauth) {
      throw new Error('OAuth management is unavailable');
    }
    await operation.run('management-transport', startOwner, 'management-failed');
    const session = await operation.run(
      'management-transport',
      () => oauth.startOAuth(undefined, operation.context.diagnosticId),
      'management-failed',
    );
    if (session.diagnosticId !== operation.context.diagnosticId) {
      throw new Error('OAuth operation identity does not match the owner');
    }
    output.stdout(`Open this URL in a browser on this machine:\n${session.authorizationUrl}\n`);
    operation.accountCommit = 'uncertain';
    const deadline = Date.now() + 6 * 60_000;
    while (Date.now() < deadline) {
      const status = await operation.run(
        'management-transport',
        () => oauth.oauthStatus(session.sessionId),
        'management-failed',
      );
      if (status.state === 'succeeded') {
        operation.accountCommit = 'confirmed';
        output.stdout(`Google account added: ${status.account.email}\n`);
        return;
      }
      if (status.state === 'failed') {
        if (status.diagnostic.diagnosticId !== operation.context.diagnosticId) {
          throw new Error('OAuth failure identity does not match the owner');
        }
        throw new DesktopOAuthLoginError(status.loginCode, status.diagnostic);
      }
      await delay(500);
    }
    throw new DesktopOAuthLoginError('login-timeout', operation.finish(undefined, 'timed-out'));
  } catch (error) {
    const diagnostic = readFinalizedOperationDiagnostic(error);
    if (diagnostic?.diagnosticId === operation.context.diagnosticId) {
      throw error;
    }
    throw new DesktopOAuthLoginError('login-failed', operation.finish(error));
  }
}
