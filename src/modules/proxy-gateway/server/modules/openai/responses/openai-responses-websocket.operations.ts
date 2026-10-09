import { isObservable } from 'rxjs';
import type { OpenAIOperations, PreparedResponsesRequest } from '../openai-operations.service';
import type { OpenAIService } from '../openai.service';
import {
  prepareOpenAIRequestSchemas,
  type PreparedOpenAISchemas,
} from '../chat/openai-schema-preparation';
import { parseResponsesRequestBody } from './openai-responses-request';
import type { OpenAIResponsesWebSocketServerDependencies } from './openai-responses-websocket.server';

/** Own Schema admission before socket state publication and reuse the result during execution. */
export function createResponsesWebSocketOperations(
  operations: Pick<OpenAIOperations, 'prepareResponsesRequest'>,
  service: Pick<OpenAIService, 'handleChatCompletions'>,
): Omit<OpenAIResponsesWebSocketServerDependencies, 'isAuthorized'> {
  const preparedRequests = new WeakMap<
    object,
    { request: PreparedResponsesRequest; schemas: PreparedOpenAISchemas }
  >();
  return {
    validateRequest: (request, mode) => {
      const body = parseResponsesRequestBody(request);
      if (!body) {
        throw new Error('Invalid Responses WebSocket request');
      }
      const prepared = operations.prepareResponsesRequest(body);
      if (!prepared) {
        throw new Error('Unknown or expired previous_response_id');
      }
      const schemas = prepareOpenAIRequestSchemas(prepared.request, 'responses');
      if (mode === 'generate') {
        preparedRequests.set(request, { request: prepared, schemas });
      }
    },
    streamRequest: async (request) => {
      const accepted = preparedRequests.get(request);
      if (!accepted) {
        throw new Error('Responses WebSocket request was not admitted');
      }
      preparedRequests.delete(request);
      const prepared = accepted.request;
      const result = await service.handleChatCompletions(
        prepared.request,
        'responses',
        undefined,
        {
          requestSessionId: prepared.requestSessionId,
          responseId: prepared.responseId,
          routingSessionId: prepared.routingSessionId,
        },
        accepted.schemas,
      );
      if (!isObservable(result)) {
        throw new Error('Responses WebSocket request did not produce a stream');
      }
      return result;
    },
  };
}
