import { Inject, Injectable } from '@nestjs/common';
import { isEmpty, isString } from 'lodash-es';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { v4 as uuidv4 } from 'uuid';
import { Observable } from 'rxjs';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import {
  toOpenAIResponsesUsage,
  toOpenAIUsageFromGeminiUsageMetadata,
} from '@/modules/proxy-gateway/antigravity/OpenAIUsageMapper';
import { OpenAIResponsesStreamingMapper } from '@/modules/proxy-gateway/antigravity/OpenAIResponsesStreamingMapper';
import {
  extractCustomToolInput,
  isCustomToolCall,
  toCustomToolArguments,
} from '@/modules/proxy-gateway/antigravity/CustomToolCall';
import { optimizeApplyPatch } from '@/modules/proxy-gateway/antigravity/ApplyPatchPreflight';
import { splitNamespaceToolName } from '@/modules/proxy-gateway/antigravity/ToolNamespace';
import { resolveShellToolName } from '@/modules/proxy-gateway/antigravity/ShellToolName';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { decodeSignature } from '@/modules/proxy-gateway/antigravity/signature-utils';
import { decodeInternalSseData } from '@/modules/proxy-gateway/antigravity/internal-sse';
import {
  GeminiRequest,
  GeminiResponse,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIUsage,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import { resolveRequestUserAgent } from '@/modules/proxy-gateway/server/common/utils/request-user-agent';
import {
  applyOpenAIModelVariant,
  rebindOpenAIModelVariant,
} from '@/modules/proxy-gateway/server/shared/services/model-variant-request.service';
import { safeStringifyPacket } from '@/shared/security/sensitiveDataMasking';
import { BaseProxyService } from '@/modules/proxy-gateway/server/common/base-proxy.service';
import {
  toGeminiUsageMetadata,
  toResponsesGroundingMetadata,
  toResponsesStreamPart,
  toUnknownRecord,
} from './responses/openai-responses-adapters';
import { ClaudeRequest, ClaudeResponse } from '@/modules/proxy-gateway/antigravity/types';
import {
  convertClaudeToOpenAIResponse,
  convertOpenAIToClaude,
  convertOpenAIToolsToAnthropicTools,
  extractOpenAIToolNames,
  mapGeminiFinishReasonToOpenAIFinishReason,
  parseOpenAIFunctionArguments,
} from './chat/openai-claude-conversion';
import { GenerationConstraintsService } from '@/modules/proxy-gateway/server/shared/services/generation-constraints.service';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/shared/services/model-routing.service';
import { ProxyRetryService } from '@/modules/proxy-gateway/server/shared/services/proxy-retry.service';
import { GeminiService } from '@/modules/proxy-gateway/server/modules/gemini/gemini.service';

export type OpenAIOutputProtocol = 'chat-completions' | 'responses';

@Injectable()
export class OpenAIService extends BaseProxyService {
  constructor(
    @Inject(AccountLeaseService) accountLeaseService: AccountLeaseService,
    @Inject(GeminiClient) geminiClient: GeminiClient,
    @Inject(GeminiService) private readonly geminiService: GeminiService,
    @Inject(GenerationConstraintsService) generationConstraints: GenerationConstraintsService,
    @Inject(ProxyRetryService) retryPolicy: ProxyRetryService,
    @Inject(ModelRoutingService) modelRoutingPolicy: ModelRoutingService,
  ) {
    super(
      accountLeaseService,
      geminiClient,
      generationConstraints,
      retryPolicy,
      modelRoutingPolicy,
    );
  }

  async handleChatCompletions(
    request: OpenAIChatRequest,
    outputProtocol: OpenAIOutputProtocol = 'chat-completions',
  ): Promise<OpenAIChatResponse | Observable<string>> {
    const appliedVariantRequest = applyOpenAIModelVariant(request);
    const routedRequest = appliedVariantRequest.request;
    const sessionKey = this.extractOpenAISessionKey(request);
    const clientToolNames = extractOpenAIToolNames(routedRequest.tools);

    const targetModel = this.resolveTargetModel(routedRequest.model);
    const extraHeaders = this.createModelSpecificHeaders(request.model);
    this.logger.log(
      `OpenAI-compatible request received: model=${request.model}, mappedModel=${targetModel}, stream=${request.stream}`,
    );

    // Retry loop for account selection
    let lastError: unknown = null;
    const maxRetries = 3;
    const retryState = this.createTokenRetryState();

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(
        i,
        maxRetries,
        'OpenAI-compatible',
        retryState.graceRetryToken !== null,
      );

      // 1. Get Token
      const token = await this.selectRetryToken(retryState, targetModel, sessionKey);
      if (!token) {
        throw new Error('No available accounts (all exhausted or rate limited)');
      }
      const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
        token.id,
        targetModel,
      );
      const effectiveVariantRequest = rebindOpenAIModelVariant(
        appliedVariantRequest,
        effectiveTargetModel,
      );
      const accountRequest = effectiveVariantRequest.request;
      const accountTargetModel = effectiveVariantRequest.variant
        ? accountRequest.model
        : effectiveTargetModel;

      try {
        const claudeRequest = convertOpenAIToClaude(accountRequest, sessionKey);
        const projectId = token.token.project_id ?? '';
        const requestUserAgent = await resolveRequestUserAgent();
        const geminiBody = transformClaudeRequestIn(
          claudeRequest,
          projectId,
          requestUserAgent,
          accountTargetModel,
        );
        this.applyInternalGenerationConstraints(
          geminiBody,
          geminiBody.model,
          token.id,
          effectiveVariantRequest.variant ?? undefined,
        );

        // Use v1internal API (same as Anthropic handler)
        if (request.stream) {
          try {
            const stream = await this.geminiClient.streamGenerateInternal(
              geminiBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
            );
            this.markUpstreamSuccess(token.id, geminiBody.model);
            return this.createOpenAIProtocolStream(
              stream,
              request.model,
              outputProtocol,
              sessionKey,
              clientToolNames,
              claudeRequest.messages.length,
            );
          } catch (streamError) {
            this.logger.warn(
              `Stream path failed for model=${request.model}; falling back to non-stream generation: ${
                streamError instanceof Error ? streamError.message : String(streamError)
              }`,
            );

            const response = await this.generateInternalWithStreamFallback(
              geminiBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
            );
            this.markUpstreamSuccess(token.id, geminiBody.model);
            this.logger.log(
              `Upstream response snippet after stream fallback: ${safeStringifyPacket(response).substring(0, 500)}`,
            );
            const claudeResponse = transformResponse(
              response,
              sessionKey,
              claudeRequest.messages.length,
            );
            const openaiResponse = convertClaudeToOpenAIResponse(
              claudeResponse,
              request.model,
              clientToolNames,
            );
            return outputProtocol === 'responses'
              ? this.createSyntheticResponsesStream(
                  openaiResponse,
                  sessionKey,
                  clientToolNames,
                  claudeRequest.messages.length,
                )
              : this.createSyntheticOpenAIStream(openaiResponse);
          }
        } else {
          const response = await this.generateInternalWithStreamFallback(
            geminiBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
          );
          this.markUpstreamSuccess(token.id, geminiBody.model);
          this.logger.log(
            `Upstream response snippet (non-stream): ${safeStringifyPacket(response).substring(0, 500)}`,
          );
          // Transform Gemini response to OpenAI format
          const claudeResponse = transformResponse(
            response,
            sessionKey,
            claudeRequest.messages.length,
          );
          this.logger.log(
            `Transformed Claude response snippet: ${safeStringifyPacket(claudeResponse).substring(0, 500)}`,
          );
          return convertClaudeToOpenAIResponse(claudeResponse, request.model, clientToolNames);
        }
      } catch (err) {
        if (err instanceof Error && this.isProjectContextError(err.message)) {
          this.logger.warn(
            `OpenAI compatibility request hit project context issue, retrying without project: ${err.message}`,
          );
          try {
            const claudeRequest = convertOpenAIToClaude(accountRequest, sessionKey);
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = transformClaudeRequestIn(
              claudeRequest,
              '',
              requestUserAgent,
              accountTargetModel,
            );
            this.applyInternalGenerationConstraints(
              fallbackBody,
              fallbackBody.model,
              token.id,
              effectiveVariantRequest.variant ?? undefined,
            );
            if (request.stream) {
              const stream = await this.geminiClient.streamGenerateInternal(
                fallbackBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              this.markUpstreamSuccess(token.id, fallbackBody.model);
              return this.createOpenAIProtocolStream(
                stream,
                request.model,
                outputProtocol,
                sessionKey,
                clientToolNames,
                claudeRequest.messages.length,
              );
            }

            const response = await this.generateInternalWithStreamFallback(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
            );
            this.markUpstreamSuccess(token.id, fallbackBody.model);
            const claudeResponse = transformResponse(
              response,
              sessionKey,
              claudeRequest.messages.length,
            );
            return convertClaudeToOpenAIResponse(claudeResponse, request.model, clientToolNames);
          } catch (fallbackErr) {
            lastError = fallbackErr;
          }
        } else {
          lastError = err;
        }

        if (
          !appliedVariantRequest.variant &&
          (await this.prepareGraceRetry(retryState, token, lastError, 'OpenAI-compatible'))
        ) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, accountTargetModel, lastError);
      }
    }
    throw lastError || new Error('Request failed after retries');
  }

  private createOpenAIProtocolStream(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    outputProtocol: OpenAIOutputProtocol,
    signatureSessionKey?: string,
    clientToolNames?: ReadonlySet<string>,
    signatureMessageCount?: number,
  ): Observable<string> {
    if (outputProtocol === 'responses') {
      return this.processResponsesStreamResponse(
        upstreamStream,
        model,
        signatureSessionKey,
        clientToolNames,
        signatureMessageCount,
      );
    }
    return this.processStreamResponse(
      upstreamStream,
      model,
      clientToolNames,
      signatureSessionKey,
      signatureMessageCount,
    );
  }

  private processResponsesStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    signatureSessionKey?: string,
    clientToolNames?: ReadonlySet<string>,
    signatureMessageCount?: number,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      const mapper = new OpenAIResponsesStreamingMapper({
        clientToolNames,
        model,
        responseId: `resp_${uuidv4()}`,
        signatureMessageCount,
        signatureSessionKey,
      });
      let heartbeatTimer: NodeJS.Timeout | undefined;

      const clearHeartbeat = (): void => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
      };

      const complete = (): void => {
        if (completed) {
          return;
        }
        completed = true;
        clearHeartbeat();
        for (const event of mapper.complete()) {
          subscriber.next(event);
        }
        subscriber.complete();
      };

      subscriber.next(mapper.createResponseCreatedEvent());
      subscriber.next(mapper.createResponseInProgressEvent());
      heartbeatTimer = setInterval(() => {
        if (!completed) {
          subscriber.next(': ping\n\n');
        }
      }, 15_000);
      const idleTimer = this.createStreamIdleTimer(
        upstreamStream,
        'OpenAI-Responses-SSE',
        complete,
      );
      idleTimer.reset();

      upstreamStream.on('data', (chunk: Buffer) => {
        if (completed) {
          return;
        }
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) {
            continue;
          }

          const dataString = trimmed.slice(6);

          try {
            const decoded = decodeInternalSseData(dataString);
            if (decoded.kind !== 'response') {
              continue;
            }

            const responsePayload = decoded.response;
            const usageMetadata = toGeminiUsageMetadata(responsePayload.usageMetadata);
            if (usageMetadata) {
              mapper.setUsage(
                toOpenAIResponsesUsage(toOpenAIUsageFromGeminiUsageMetadata(usageMetadata)),
              );
            }
            const candidates = responsePayload.candidates;
            if (!Array.isArray(candidates)) {
              continue;
            }

            const candidate = toUnknownRecord(candidates[0]);
            const content = toUnknownRecord(candidate?.content);
            const parts = content?.parts;
            if (Array.isArray(parts)) {
              for (const part of parts) {
                const normalizedPart = toResponsesStreamPart(part);
                if (!normalizedPart) {
                  continue;
                }
                for (const event of mapper.processPart(normalizedPart)) {
                  subscriber.next(event);
                }
              }
            }

            const grounding = toResponsesGroundingMetadata(candidate?.groundingMetadata);
            if (grounding) {
              for (const event of mapper.processGrounding(grounding)) {
                subscriber.next(event);
              }
            }

            if (isString(candidate?.finishReason) && candidate.finishReason.length > 0) {
              complete();
              return;
            }
          } catch {
            // Preserve compatibility: ignore per-chunk mapping failures.
          }
        }
      });

      upstreamStream.on('end', () => {
        idleTimer.clear();
        complete();
      });

      upstreamStream.on('error', (error: unknown) => {
        idleTimer.clear();
        clearHeartbeat();
        const cleanError =
          error instanceof Error ? new Error(error.message) : new Error(String(error));
        this.logger.error(`OpenAI Responses stream error: ${cleanError.message}`);
        subscriber.error(cleanError);
      });

      return () => {
        clearHeartbeat();
        idleTimer.dispose();
      };
    });
  }

  private processStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    clientToolNames?: ReadonlySet<string>,
    signatureSessionKey?: string,
    signatureMessageCount?: number,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let hasEmittedChunk = false;
      let hasSentDone = false;
      let lastUsage: OpenAIUsage | undefined;
      let toolCallIndex = 0;
      const emittedToolCalls = new Set<string>();

      const streamId = `chatcmpl-${uuidv4()}`;
      const created = Math.floor(Date.now() / 1000);
      if (this.shouldEmitCloudCodeMeta()) {
        subscriber.next(this.createCloudCodeMetaChunk(this.createCloudCodeTraceId()));
      }

      const pushChunk = (payload: Record<string, unknown>): void => {
        hasEmittedChunk = true;
        subscriber.next(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'OpenAI-SSE', () => {
        if (!hasSentDone) {
          subscriber.next('data: [DONE]\n\n');
          hasSentDone = true;
        }
        subscriber.complete();
      });

      idleTimer.reset();

      upstreamStream.on('data', (chunk: Buffer) => {
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);

          try {
            const decoded = decodeInternalSseData(dataStr);
            if (decoded.kind !== 'response') {
              continue;
            }

            const responsePayload = decoded.response;
            const usageMetadata = toGeminiUsageMetadata(responsePayload.usageMetadata);
            if (usageMetadata) {
              lastUsage = toOpenAIUsageFromGeminiUsageMetadata(usageMetadata);
            }

            const candidates = Array.isArray(responsePayload.candidates)
              ? responsePayload.candidates
              : [];
            for (const [candidateIndex, candidateValue] of candidates.entries()) {
              const candidate = toUnknownRecord(candidateValue);
              const content = toUnknownRecord(candidate?.content);
              const parts = Array.isArray(content?.parts) ? content.parts : [];
              // Keep these streams separate because clients can render thought text twice when
              // reasoning_content and content are present in the same delta.
              let reasoningContent = '';
              let responseContent = '';

              for (const partValue of parts) {
                const part = toUnknownRecord(partValue);
                if (!part) {
                  continue;
                }

                if (isString(part.text)) {
                  const cleanText = part.text
                    .replaceAll('<think>\n', '')
                    .replaceAll('<think>', '')
                    .replaceAll('\n</think>', '')
                    .replaceAll('</think>', '');
                  if (part.thought === true) {
                    reasoningContent += cleanText;
                  } else {
                    responseContent += cleanText;
                  }
                }

                const rawSignature = isString(part.thoughtSignature)
                  ? part.thoughtSignature
                  : isString(part.thought_signature)
                    ? part.thought_signature
                    : undefined;
                const signature = decodeSignature(rawSignature);
                if (signature) {
                  SignatureStore.store(signature, signatureSessionKey, signatureMessageCount);
                }

                const functionCall = toUnknownRecord(part.functionCall);
                if (functionCall && isString(functionCall.name)) {
                  const dedupeKey = JSON.stringify(functionCall);
                  if (emittedToolCalls.has(dedupeKey)) {
                    continue;
                  }
                  emittedToolCalls.add(dedupeKey);

                  const splitName = splitNamespaceToolName(functionCall.name);
                  const functionName = clientToolNames
                    ? resolveShellToolName(splitName.name, clientToolNames)
                    : splitName.name;
                  const rawArguments = toUnknownRecord(functionCall.args) ?? {};
                  const functionArguments = isCustomToolCall(functionName)
                    ? toCustomToolArguments(
                        functionName,
                        optimizeApplyPatch(extractCustomToolInput(functionName, rawArguments))
                          .input,
                      )
                    : rawArguments;
                  const toolCallChunk = {
                    id: streamId,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [
                      {
                        index: candidateIndex,
                        delta: {
                          role: 'assistant',
                          tool_calls: [
                            {
                              index: toolCallIndex,
                              id: isString(functionCall.id)
                                ? functionCall.id
                                : `${functionName}-${uuidv4()}`,
                              type: 'function',
                              function: {
                                name: functionName,
                                arguments: JSON.stringify(functionArguments),
                              },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  pushChunk(toolCallChunk);
                  toolCallIndex += 1;
                }

                const inlineData = toUnknownRecord(part.inlineData);
                if (inlineData) {
                  const mimeType = isString(inlineData.mimeType)
                    ? inlineData.mimeType
                    : 'image/jpeg';
                  const data = isString(inlineData.data) ? inlineData.data : '';
                  responseContent += `\n\n![Generated Image](data:${mimeType};base64,${data})\n\n`;
                }
              }

              if (reasoningContent) {
                const reasoningChunk = {
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [
                    {
                      index: candidateIndex,
                      delta: {
                        role: 'assistant',
                        content: null,
                        reasoning_content: reasoningContent,
                      },
                      finish_reason: null,
                    },
                  ],
                };
                pushChunk(reasoningChunk);
              }

              if (responseContent) {
                const contentChunk = {
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [
                    {
                      index: candidateIndex,
                      delta: { content: responseContent },
                      finish_reason: null,
                    },
                  ],
                };
                pushChunk(contentChunk);
              }

              if (candidate && isString(candidate.finishReason)) {
                const finishChunk = {
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [
                    {
                      index: candidateIndex,
                      delta: {},
                      // OpenAI clients only continue the tool loop when the finish reason reflects
                      // the emitted tool call, even if Gemini reports a generic STOP.
                      finish_reason:
                        emittedToolCalls.size > 0
                          ? 'tool_calls'
                          : mapGeminiFinishReasonToOpenAIFinishReason(candidate.finishReason),
                    },
                  ],
                  usage: lastUsage,
                };
                pushChunk(finishChunk);
                subscriber.next('data: [DONE]\n\n');
                hasSentDone = true;
                subscriber.complete();
                return;
              }
            }
          } catch {
            // Preserve compatibility: ignore per-chunk mapping failures.
          }
        }
      });

      upstreamStream.on('end', () => {
        idleTimer.clear();
        if (!hasEmittedChunk) {
          pushChunk({
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { content: '' },
                finish_reason: null,
              },
            ],
          });
        }
        if (!hasSentDone) {
          subscriber.next('data: [DONE]\n\n');
          hasSentDone = true;
        }
        subscriber.complete();
      });

      upstreamStream.on('error', (err: unknown) => {
        idleTimer.clear();
        // Convert to clean Error to avoid circular reference issues (socket objects)
        const cleanError = err instanceof Error ? new Error(err.message) : new Error(String(err));
        this.logger.error(`OpenAI-compatible stream error: ${cleanError.message}`);
        subscriber.error(cleanError);
      });

      return () => {
        idleTimer.dispose();
      };
    });
  }

  private createSyntheticOpenAIStream(response: OpenAIChatResponse): Observable<string> {
    return new Observable<string>((subscriber) => {
      const streamId = response.id || `chatcmpl-${uuidv4()}`;
      const created = response.created || Math.floor(Date.now() / 1000);
      const model = response.model;
      const choice = response.choices?.[0];
      const finishReason = choice?.finish_reason ?? 'stop';
      const content =
        choice?.message && isString(choice.message.content) ? choice.message.content : '';
      const chunkSize = 80;

      if (this.shouldEmitCloudCodeMeta()) {
        subscriber.next(this.createCloudCodeMetaChunk(this.createCloudCodeTraceId()));
      }

      if (content.length === 0) {
        const finishChunk = {
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
            },
          ],
          usage: response.usage,
        };
        subscriber.next(`data: ${JSON.stringify(finishChunk)}\n\n`);
        subscriber.next('data: [DONE]\n\n');
        subscriber.complete();
        return;
      }

      for (let index = 0; index < content.length; index += chunkSize) {
        const piece = content.slice(index, index + chunkSize);
        const isLast = index + chunkSize >= content.length;
        const chunk = {
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content: piece },
              finish_reason: isLast ? finishReason : null,
            },
          ],
          usage: isLast
            ? response.usage
            : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        subscriber.next(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      subscriber.next('data: [DONE]\n\n');
      subscriber.complete();
    });
  }

  private createSyntheticResponsesStream(
    response: OpenAIChatResponse,
    signatureSessionKey?: string,
    clientToolNames?: ReadonlySet<string>,
    signatureMessageCount?: number,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const mapper = new OpenAIResponsesStreamingMapper({
        clientToolNames,
        model: response.model,
        responseId: `resp_${uuidv4()}`,
        signatureMessageCount,
        signatureSessionKey,
      });
      const choice = response.choices?.[0];
      const content =
        choice?.message && isString(choice.message.content) ? choice.message.content : undefined;

      subscriber.next(mapper.createResponseCreatedEvent());
      subscriber.next(mapper.createResponseInProgressEvent());
      mapper.setUsage(toOpenAIResponsesUsage(response.usage));
      if (content) {
        for (const event of mapper.processPart({ text: content })) {
          subscriber.next(event);
        }
      }

      for (const toolCall of choice?.message?.tool_calls ?? []) {
        const functionName =
          toolCall.function?.name ??
          (toolCall.operation || toolCall.type === 'apply_patch_call' ? 'apply_patch' : null);
        if (!functionName) {
          continue;
        }
        for (const event of mapper.processPart({
          functionCall: {
            args:
              toolCall.operation ??
              parseOpenAIFunctionArguments(toolCall.function?.arguments ?? '{}'),
            id: toolCall.call_id || toolCall.id,
            name: functionName,
          },
        })) {
          subscriber.next(event);
        }
      }

      for (const event of mapper.complete()) {
        subscriber.next(event);
      }
      subscriber.complete();
    });
  }

  // Convert OpenAI request format to Claude/Anthropic format
  // Thin delegates kept on the service on purpose. The conversion itself lives in
  // `chat/openai-claude-conversion.ts`, but these two are reached through the service
  // instance by the existing parity and retry suites, and this split is meant to preserve
  // the surface as well as the behavior.
  private convertOpenAIToClaude(
    request: OpenAIChatRequest,
    signatureSessionKey?: string,
  ): ClaudeRequest {
    return convertOpenAIToClaude(request, signatureSessionKey);
  }

  private convertClaudeToOpenAIResponse(
    claudeResponse: ClaudeResponse,
    model: string,
    clientToolNames?: ReadonlySet<string>,
  ): OpenAIChatResponse {
    return convertClaudeToOpenAIResponse(claudeResponse, model, clientToolNames);
  }

  private convertOpenAIToolsToAnthropicTools(
    tools: OpenAIChatRequest['tools'],
  ): ReturnType<typeof convertOpenAIToolsToAnthropicTools> {
    return convertOpenAIToolsToAnthropicTools(tools);
  }

  private extractOpenAISessionKey(request: OpenAIChatRequest): string | undefined {
    const extra = request.extra;
    const sessionCandidate =
      extra?.session_id ?? extra?.sessionId ?? extra?.user_id ?? extra?.userId;
    if (!isString(sessionCandidate) || isEmpty(sessionCandidate.trim())) {
      return undefined;
    }
    return `openai:${sessionCandidate.trim()}`;
  }

  async handleGeminiGenerateContent(
    model: string,
    request: GeminiRequest,
  ): Promise<GeminiResponse> {
    return this.geminiService.handleGeminiGenerateContent(model, request);
  }
}
