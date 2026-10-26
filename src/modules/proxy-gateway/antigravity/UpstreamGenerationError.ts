export type GenerationFailureCode =
  | 'invalid_upstream_response'
  | 'incomplete_upstream_response'
  | 'empty_upstream_response'
  | 'empty_thinking_response';

const MESSAGES: Record<GenerationFailureCode, string> = {
  invalid_upstream_response: 'Upstream returned an invalid generation response.',
  incomplete_upstream_response: 'Upstream generation ended without a finish reason.',
  empty_upstream_response: 'Upstream returned no usable output.',
  empty_thinking_response: 'Upstream returned empty thinking-only response',
};

/** A final provider-protocol outcome, never a signal to repeat the generation. */
export class UpstreamGenerationError extends Error {
  readonly status = 502;
  constructor(readonly code: GenerationFailureCode) {
    super(MESSAGES[code]);
    this.name = 'UpstreamGenerationError';
  }
}

const terminalFailures = new WeakSet<Error>();

export function markTerminalGenerationFailure(error: unknown): unknown {
  if (error instanceof Error) {
    terminalFailures.add(error);
  }
  return error;
}

export function isTerminalGenerationFailure(error: unknown): boolean {
  return (
    error instanceof UpstreamGenerationError ||
    (error instanceof Error && terminalFailures.has(error))
  );
}
