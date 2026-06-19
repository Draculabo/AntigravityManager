interface NamedSentryIntegration {
  name?: string;
}

export function filterCrashSafeSentryIntegrations<T extends NamedSentryIntegration>(
  integrations: T[],
): T[] {
  return integrations.filter((integration) => integration.name !== 'GpuContext');
}
