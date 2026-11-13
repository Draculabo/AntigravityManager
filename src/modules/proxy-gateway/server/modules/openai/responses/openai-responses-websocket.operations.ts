import { isObservable } from 'rxjs';
import type { SignatureScopeContext } from '../../../common/signature-session-scope';
import type { OpenAIOperations, PreparedResponsesRequest } from '../openai-operations.service';
import type { OpenAIService } from '../openai.service';
import {
  prepareOpenAIRequestSchemas,
  validateOpenAIRequestTools,
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
    {
      request: PreparedResponsesRequest;
      schemas: PreparedOpenAISchemas;
      context?: SignatureScopeContext;
    }
  >();
  return {
    validateRequest: async (request, mode, context) => {
      const body = parseResponsesRequestBody(request);
      if (!body) {
        throw new Error('Invalid Responses WebSocket request');
      }
      const prepared = await operations.prepareResponsesRequest(body, context);
      if (!prepared) {
        throw new Error('Unknown or expired previous_response_id');
      }
      const schemas = prepareOpenAIRequestSchemas(prepared.request, 'responses');
      validateOpenAIRequestTools(prepared.request.tool_choice, schemas.schemas, 'responses');
      if (mode === 'generate') {
        preparedRequests.set(request, { request: prepared, schemas, context });
      }
    },
    streamRequest: async (request, signal) => {
      const accepted = preparedRequests.get(request);
      if (!accepted) {
        throw new Error('Responses WebSocket request was not admitted');
      }
      preparedRequests.delete(request);
      const prepared = accepted.request;
      const result = await service.handleChatCompletions(
        prepared.request,
        'responses',
        signal,
        {
          identity: prepared.session.identity,
          transient: prepared.transient,
          mediaAdmitted: true,
          requestSessionId: prepared.requestSessionId,
          responseId: prepared.responseId,
          routingSessionId: prepared.routingSessionId,
        },
        accepted.schemas,
        accepted.context,
      );
      if (!isObservable(result)) {
        throw new Error('Responses WebSocket request did not produce a stream');
      }
      return result;
    },
  };
}
