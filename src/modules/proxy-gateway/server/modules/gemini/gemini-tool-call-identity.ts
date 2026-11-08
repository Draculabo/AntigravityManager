import { InvalidToolResultAssociationError } from '@/modules/proxy-gateway/antigravity/ClaudeToolResultAssociation';
import { hashSessionAnchor } from '../../common/session-anchor-hash';
import type {
  GeminiContent,
  GeminiPart,
  GeminiRequest,
} from '../../common/interfaces/request-interfaces';

/**
 * Normalize optional native Gemini call IDs while preserving the caller's request.
 * Result-only continuations are accepted only when there is one pending call.
 */
export function normalizeGeminiToolCallIds(request: GeminiRequest): GeminiRequest {
  const needsGeneratedId = request.contents.some((content) =>
    content.parts.some((part) => part.functionCall && !part.functionCall.id),
  );
  let anchor = needsGeneratedId ? hashSessionAnchor(['gemini-tool-identity:v1']) : '';
  const pending = new Map<string, string>();
  let changed = false;

  const contents = request.contents.map((content, contentIndex): GeminiContent => {
    let contentChanged = false;
    let contentAnchor = needsGeneratedId
      ? hashSessionAnchor([anchor, 'content', content.role])
      : '';
    const parts = content.parts.map((part, partIndex): GeminiPart => {
      if (part.functionCall && part.functionResponse) {
        throw new InvalidToolResultAssociationError(
          `contents[${contentIndex}].parts[${partIndex}]`,
          'conflicting-item-id',
        );
      }

      if (part.functionCall) {
        const call = part.functionCall;
        const id =
          call.id ||
          `call_${hashSessionAnchor([
            contentAnchor,
            'function-call',
            partIndex,
            call.name,
            call.args,
          ]).slice(0, 32)}`;
        if (pending.has(id)) {
          throw new InvalidToolResultAssociationError(
            `contents[${contentIndex}].parts[${partIndex}]`,
            'duplicate-pending-id',
          );
        }
        pending.set(id, call.name);

        const normalizedPart = call.id === id ? part : { ...part, functionCall: { ...call, id } };
        contentChanged ||= normalizedPart !== part;
        if (needsGeneratedId) {
          contentAnchor = hashSessionAnchor([contentAnchor, 'part', normalizedPart]);
        }
        return normalizedPart;
      }

      if (part.functionResponse) {
        const response = part.functionResponse;
        let id = response.id;
        if (!id) {
          if (pending.size !== 1) {
            throw new InvalidToolResultAssociationError(
              `contents[${contentIndex}].parts[${partIndex}]`,
              pending.size > 1 ? 'ambiguous-missing-id' : 'missing-pending-call',
            );
          }
          id = [...pending.keys()][0];
        } else if (!pending.has(id)) {
          throw new InvalidToolResultAssociationError(
            `contents[${contentIndex}].parts[${partIndex}]`,
            'missing-pending-call',
          );
        }
        const callName = pending.get(id);
        // Only an explicit pending ID can replace the exact client placeholder.
        const name =
          response.id && response.name === 'unknown' && callName && callName !== 'unknown'
            ? callName
            : response.name;
        if (callName !== name) {
          throw new InvalidToolResultAssociationError(
            `contents[${contentIndex}].parts[${partIndex}]`,
            'conflicting-result-name',
          );
        }
        pending.delete(id);

        const normalizedPart =
          response.id === id && response.name === name
            ? part
            : { ...part, functionResponse: { ...response, id, name } };
        contentChanged ||= normalizedPart !== part;
        if (needsGeneratedId) {
          contentAnchor = hashSessionAnchor([contentAnchor, 'part', normalizedPart]);
        }
        return normalizedPart;
      }

      if (needsGeneratedId) {
        contentAnchor = hashSessionAnchor([contentAnchor, 'part', part]);
      }
      return part;
    });

    const normalizedContent = contentChanged ? { ...content, parts } : content;
    changed ||= normalizedContent !== content;
    if (needsGeneratedId) {
      anchor = contentAnchor;
    }
    return normalizedContent;
  });

  return changed ? { ...request, contents } : request;
}
