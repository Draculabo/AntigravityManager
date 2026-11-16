import { addBreadcrumb, close, flush, setContext, setTag, setUser } from '@sentry/node';
import { verifyOperationReporting } from './operation-sentry';
import { initializeCoreErrorReporting } from '../../../src/core/error-reporting';

void verifyOperationReporting(
  async () => initializeCoreErrorReporting(),
  { addBreadcrumb, close, flush, setContext, setTag, setUser },
  'standalone-core',
).catch(() => {
  process.stderr.write('Controlled core operation reporting failed.\n');
  process.exitCode = 1;
});
