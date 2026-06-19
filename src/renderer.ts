async function initializeRendererSentry() {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  try {
    const config = await window.electron?.getObservabilityConfig();
    if (!config?.errorReportingEnabled) {
      return;
    }

    const Sentry = await import('@sentry/electron/renderer');
    setTimeout(() => {
      Sentry.init({
        dsn: process.env.SENTRY_DSN,
      });
    }, 2000);
  } catch (error) {
    console.warn('Sentry initialization failed:', error);
  }
}

void initializeRendererSentry();

import '@/App';
