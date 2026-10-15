/** Fail closed before any profile or native-client path can be resolved by the SDK harness. */
export function getAgentDir(): string {
  const directory = process.env.AGM_DIAGNOSTIC_DIRECTORY;
  if (!directory) {
    throw new Error('An isolated diagnostic directory is required');
  }
  return directory;
}
