import { describe, it, expect } from 'vitest';
import {
  classifyStreamError,
  formatErrorForSSE,
} from '../../modules/proxy-gateway/antigravity/stream-error-utils';

describe('classifyStreamError', () => {
  it.each([
    ['ECONNREFUSED', 'connection_error'],
    ['ECONNRESET', 'stream_error'],
    ['ENOTFOUND', 'network_error'],
    ['ERR_CANCELED', 'cancelled_error'],
  ])('keeps structured %s ahead of timeout text', (code, type) => {
    expect(classifyStreamError(Object.assign(new Error('controlled timeout'), { code })).type).toBe(
      type,
    );
  });

  it('should identify timeout errors', () => {
    const error = new Error('timeout of 30000ms exceeded');
    const { type, message } = classifyStreamError(error);
    expect(type).toBe('timeout_error');
    expect(message).toContain('timed out');
  });

  it('should identify connection errors', () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:8080');
    const { type, message } = classifyStreamError(error);
    expect(type).toBe('connection_error');
    expect(message).toContain('connect');
  });

  it('should identify network DNS errors', () => {
    const error = new Error('getaddrinfo ENOTFOUND googleapis.com');
    const { type, message } = classifyStreamError(error);
    expect(type).toBe('network_error');
    expect(message).toContain('Network');
  });

  it('should identify socket errors', () => {
    const error = new Error('socket hang up');
    const { type, message } = classifyStreamError(error);
    expect(type).toBe('stream_error');
    expect(message).toContain('interrupted');
  });

  it.each(['response stream timed out', 'request deadline exceeded'])(
    'should classify %s as a timeout',
    (text) => {
      expect(classifyStreamError(new Error(text)).type).toBe('timeout_error');
    },
  );

  it('should classify a body-read connection reset as a transfer error', () => {
    expect(classifyStreamError(new Error('error reading body from connection: reset')).type).toBe(
      'stream_error',
    );
  });

  it.each(['Connection timed out while reading', 'deadline exceeded', 'DEADLINE_EXCEEDED'])(
    'classifies %s as a timeout',
    (message) => {
      expect(classifyStreamError(new Error(message)).type).toBe('timeout_error');
    },
  );

  it('classifies a body read reset as a stream error instead of connection setup', () => {
    expect(
      classifyStreamError(new Error('error reading a body from connection: connection reset')).type,
    ).toBe('stream_error');
  });

  it('should return generic message for unknown errors', () => {
    const error = new Error('some random error');
    const { type, message } = classifyStreamError(error);
    expect(type).toBe('unknown_error');
    expect(message).toBeTruthy();
    expect(message).toContain('some random error');
  });
});

describe('formatErrorForSSE', () => {
  it('should format as Claude SSE error event', () => {
    const result = formatErrorForSSE('network_error', 'Network connection failed');
    expect(result).toContain('event: error');
    expect(result).toContain('"type":"error"');
    expect(result).toContain('network_error');
    expect(result).toContain('Network connection failed');
  });

  it('should end with newlines', () => {
    const result = formatErrorForSSE('test', 'test');
    expect(result.endsWith('\n\n')).toBe(true);
  });

  it('should be valid SSE format', () => {
    const result = formatErrorForSSE('timeout_error', 'Request timed out');
    expect(result.startsWith('event: ')).toBe(true);
    expect(result).toContain('\ndata: ');
  });
});
