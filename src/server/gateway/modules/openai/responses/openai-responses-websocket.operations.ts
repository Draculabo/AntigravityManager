import { isObservable } from 'rxjs';
import { NotFoundException } from '@nestjs/common';
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
  operations: Pick<OpenAIOperations, 'prepareResponsesRequest' | 'cacheResponsesStream'>,
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
        throw new NotFoundException('Unknown or expired previous_response_id');
      }
      const schemas = prepareOpenAIRequestSchemas(prepared.request, 'responses');
      validateOpenAIRequestTools(prepared.request.tool_choice, schemas.schemas, 'responses');
      if (mode === 'generate') {
        if (body.previous_response_id) {
          // A fresh connection retains the authorized parent's complete transcript for later appends.
          request.input = prepared.resolvedInput;
          request.model ??= prepared.session.model;
          request.instructions ??= prepared.session.instructions;
          request.tools ??= prepared.session.tools;
        }
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
          mediaWindowProtectLatestUserTurn: prepared.mediaWindowProtectLatestUserTurn,
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
      // Publish completion only after the HTTP-owned history writer commits the same record.
      return prepared.transient
        ? result
        : operations.cacheResponsesStream(result, prepared, signal);
    },
  };
}
