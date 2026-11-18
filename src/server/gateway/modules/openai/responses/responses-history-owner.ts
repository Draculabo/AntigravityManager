import { tenantIdentity } from '../../../common/signature-session-scope';
import type { RequestHeaders } from '../../../guards/api-key-auth.util';
import type {
  OpenAIResponsesSessionStoreLike,
  OpenAIResponsesSessionWithParent,
} from './openai-responses-session.store';
import type { OpenAIResponsesMediaStore } from './openai-responses-media-store';

/** A one-way caller digest, not an encryption key or a raw proxy credential. */
export type ResponsesHistoryOwner = 'unknown' | `sha256-v1:${string}`;

export function resolveResponsesHistoryOwner(headers: RequestHeaders = {}): ResponsesHistoryOwner {
  return `sha256-v1:${tenantIdentity(headers)}`;
}

/** Missing provenance stays unknown; malformed explicit ownership rejects the record. */
export function decodeResponsesHistoryOwner(value: unknown): ResponsesHistoryOwner | null {
  if (value === undefined || value === 'unknown') {
    return 'unknown';
  }
  return typeof value === 'string' && /^sha256-v1:[a-f0-9]{64}$/.test(value)
    ? (value as ResponsesHistoryOwner)
    : null;
}

/** Check provenance before materializing history or refreshing its retention. */
export function getOwnedResponsesHistory(
  store: OpenAIResponsesSessionStoreLike,
  responseId: string,
  owner: ResponsesHistoryOwner,
): OpenAIResponsesSessionWithParent | null {
  if (owner === 'unknown' || store.getHistoryOwner(responseId) !== owner) {
    return null;
  }
  return store.getWithParent(responseId);
}

export function resolveResponsesMediaStore(
  store: OpenAIResponsesSessionStoreLike,
): OpenAIResponsesMediaStore | undefined {
  return typeof Reflect.get(store, 'getMediaStore') === 'function'
    ? (Reflect.apply(Reflect.get(store, 'getMediaStore'), store, []) as
        | OpenAIResponsesMediaStore
        | undefined)
    : undefined;
}
