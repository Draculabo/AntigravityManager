import { z } from 'zod';

export const TrafficClassSchema = z.enum(['model', 'auxiliary', 'ipc', 'system']);

export type TrafficClass = z.infer<typeof TrafficClassSchema>;

const MODEL_ROUTE_PATTERNS = [
  /^\/v1\/(?:chat\/completions|responses|messages|complete|images\/generations)\/?$/iu,
  /^\/(?:v1|v1beta)\/models\/[^/?#:]+:(?:generateContent|streamGenerateContent)\/?$/iu,
  /^\/compatible\/.+(?:completions|responses|messages|generateContent)\/?$/iu,
];

const AUXILIARY_ROUTE_PATTERNS = [
  /^\/v1\/models(?:\/|$)/iu,
  /^\/v1\/messages\/count_tokens\/?$/iu,
  /^\/(?:v1|v1beta)\/models\/[^/?#:]+:countTokens\/?$/iu,
  /^\/v1internal\/countTokens\/?$/iu,
  /^\/(?:upload\/)?v1beta\/files(?:\/|$)/iu,
  /^\/v1\/files(?:\/|$)/iu,
  /^\/v1\/batches(?:\/|$)/iu,
  /^\/v1\/messages\/batches(?:\/|$)/iu,
  /^\/v1beta\/batches(?:\/|$)/iu,
  /^\/v1beta\/models\/[^/?#:]+:batchGenerateContent\/?$/iu,
  /^\/v1\/(?:responses|chat\/completions)\/.+/iu,
];

const SYSTEM_ROUTE_PATTERNS = [/^\/healthz?\/?$/iu, /^\/internal(?:\/|$)/iu];

/**
 * Resolves the durable audit category at the transport boundary. Keeping this
 * classification out of queries prevents historical records from changing category
 * when routes evolve.
 */
export function classifyHttpTraffic(method: string, rawUrl: string): TrafficClass {
  const pathname = rawUrl.split(/[?#]/u, 1)[0] || '/';
  if (SYSTEM_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname))) {
    return 'system';
  }
  if (AUXILIARY_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname))) {
    return 'auxiliary';
  }
  if (MODEL_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname))) {
    return 'model';
  }

  // Unknown mutating compatibility routes are more likely to be generation surfaces.
  // Read-only unknown routes remain auxiliary so they cannot crowd the primary model view.
  return method.toUpperCase() === 'POST' ? 'model' : 'auxiliary';
}
