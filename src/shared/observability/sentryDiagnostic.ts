import type { ErrorEvent } from '@sentry/node';

/** Isolated diagnostic events must not inherit surrounding request or account context. */
export function isolateSentryDiagnostic(event: ErrorEvent): void {
  if (event.tags?.isolated_diagnostic !== 'true') {
    return;
  }
  const runtime = event.tags.runtime;
  event.tags = {
    isolated_diagnostic: 'true',
    ...(runtime === 'standalone-core' || runtime === 'desktop-embedded' ? { runtime } : {}),
  };
  delete event.breadcrumbs;
  // Relay infers geo from the connection IP when geo is absent, even with sendDefaultPii disabled.
  // An explicitly empty geo prevents enrichment without sending identity or location data.
  event.user = { geo: {} };
  delete event.request;
  delete event.contexts;
  delete event.extra;
  delete event.exception;
  delete event.server_name;
  delete event.transaction;
  delete event.transaction_info;
  delete event.threads;
  delete event.debug_meta;
}
