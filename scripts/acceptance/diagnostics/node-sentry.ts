import * as Sentry from '@sentry/node';
import { verifyOperationReporting } from './operation-sentry';
import { initializeCoreErrorReporting } from '../../../src/core/error-reporting';

void verifyOperationReporting(
  async () => initializeCoreErrorReporting(),
  Sentry,
  'standalone-core',
).catch(() => {
  process.stderr.write('Controlled core operation reporting failed.\n');
  process.exitCode = 1;
});
