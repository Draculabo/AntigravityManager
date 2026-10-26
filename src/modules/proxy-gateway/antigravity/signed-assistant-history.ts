interface SignatureCandidate {
  type: string;
  signature?: string;
}

/** Explicit signature presence protects replay bytes; this does not validate the signature. */
export function hasExplicitAssistantSignature(
  role: string,
  content: string | readonly SignatureCandidate[],
): boolean {
  return (
    role === 'assistant' &&
    typeof content !== 'string' &&
    content.some(
      (block) =>
        (block.type === 'thinking' || block.type === 'tool_use') && Boolean(block.signature),
    )
  );
}
