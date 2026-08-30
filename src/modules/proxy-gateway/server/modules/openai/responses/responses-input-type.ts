/** Resolve raw history and request items identically without rewriting stored payloads. */
export function resolveResponsesInputType(item: unknown): string | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return null;
  }
  const type: unknown = Reflect.get(item, 'type');
  if (typeof type === 'string' && type.length > 0) {
    return type;
  }
  // Empty types were accepted by our previous writer and must remain replayable.
  const role: unknown = Reflect.get(item, 'role');
  return typeof role === 'string' ? 'message' : null;
}
