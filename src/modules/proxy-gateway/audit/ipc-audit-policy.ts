export function isAuditManagementIpc(path: string): boolean {
  return (
    path.startsWith('gateway/audit') ||
    path.startsWith('gateway/thought') ||
    path.startsWith('config/') ||
    (path.startsWith('gateway/') && path.toLowerCase().includes('opencode'))
  );
}

export function readIpcSessionId(input: unknown): string | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  for (const key of ['session_id', 'sessionId', 'conversation_id', 'conversationId']) {
    const value = Reflect.get(input, key);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
