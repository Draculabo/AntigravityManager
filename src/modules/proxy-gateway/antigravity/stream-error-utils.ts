/**
 * Stream Error Utilities
 * Classifies network errors and formats user-friendly messages
 *
 * Problem: Technical error messages confuse users
 * Solution: Classify errors and provide localized, actionable messages
 */

export interface ClassifiedError {
  type: string;
  message: string;
}

export type UpstreamTransportFailure =
  | 'timeout'
  | 'transfer'
  | 'connection'
  | 'network'
  | 'cancelled';

/** Recognized transport codes take precedence over free-form message text. */
export function classifyTransportError(error: Error): UpstreamTransportFailure | undefined {
  const rawCode: unknown = Reflect.get(error, 'code');
  const code = typeof rawCode === 'string' ? rawCode.toUpperCase() : '';
  if (error.name === 'AbortError' || code === 'ERR_CANCELED' || code === 'ABORT_ERR') {
    return 'cancelled';
  }
  switch (code) {
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
    case 'ECONNABORTED':
      return 'timeout';
    case 'ECONNRESET':
    case 'EPIPE':
    case 'ERR_STREAM_PREMATURE_CLOSE':
      return 'transfer';
    case 'ECONNREFUSED':
      return 'connection';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
    case 'ERR_NETWORK':
      return 'network';
  }
  const msg = error.message.toLowerCase();
  if (msg.includes('cancelled') || msg.includes('canceled')) {
    return 'cancelled';
  }
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('timedout') ||
    msg.includes('deadline exceeded') ||
    msg.includes('deadline_exceeded')
  ) {
    return 'timeout';
  }
  if (
    msg.includes('reading body from connection') ||
    msg.includes('reading a body from connection') ||
    msg.includes('epipe') ||
    msg.includes('reset') ||
    msg.includes('socket') ||
    msg.includes('broken pipe') ||
    msg.includes('aborted')
  ) {
    return 'transfer';
  }
  if (
    msg.includes('econnrefused') ||
    msg.includes('connection refused') ||
    msg.includes('failed to connect') ||
    msg.startsWith('connect ') ||
    msg.includes('secure tls connection was established')
  ) {
    return 'connection';
  }
  if (
    msg.includes('enotfound') ||
    msg.includes('eai_again') ||
    msg.includes('network') ||
    msg.includes('dns')
  ) {
    return 'network';
  }
  return undefined;
}

/**
 * Classify a stream error and return user-friendly message
 *
 * @param error - The error object
 * @returns Classified error with type and localized message
 */
export function classifyStreamError(error: Error): ClassifiedError {
  const failure = classifyTransportError(error);
  if (failure === 'cancelled') {
    return { type: 'cancelled_error', message: 'Request cancelled.' };
  }
  if (failure === 'timeout') {
    return {
      type: 'timeout_error',
      message: 'Request timed out. Please check your network connection or try again later.',
    };
  }

  if (failure === 'transfer') {
    return {
      type: 'stream_error',
      message: 'Data transfer interrupted. Please try again later.',
    };
  }

  if (failure === 'connection') {
    return {
      type: 'connection_error',
      message: 'Unable to connect to server. Please check your network.',
    };
  }

  if (failure === 'network') {
    return {
      type: 'network_error',
      message: 'Network connection failed. Please check your network settings.',
    };
  }

  return {
    type: 'unknown_error',
    message: `Unknown error occurred: ${error.message.substring(0, 100)}`,
  };
}

/**
 * Format error as SSE event for Claude protocol
 *
 * @param errorType - Error type string
 * @param message - User-friendly message
 * @returns SSE-formatted error event string
 */
export function formatErrorForSSE(errorType: string, message: string): string {
  const errorEvent = {
    type: 'error',
    error: {
      type: errorType,
      message: message,
      code: 'stream_error',
    },
  };

  return `event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`;
}
