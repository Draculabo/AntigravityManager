import { app } from 'electron';
import * as Sentry from '@sentry/electron/main';
import { verifyOperationReporting } from './operation-sentry';
import '../../../src/instrument';

void verifyOperationReporting(async () => {}, Sentry, 'desktop-embedded')
  .then(() => {
    app.exit(0);
  })
  .catch(() => {
    process.stderr.write('Controlled desktop operation reporting failed.\n');
    app.exit(1);
  });
