import { Inject, Injectable } from '@nestjs/common';
import { isEmpty, isNil, isNumber, isPlainObject, isString } from 'lodash-es';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { v4 as uuidv4 } from 'uuid';
import { Observable } from 'rxjs';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import {
  toOpenAIResponsesUsage,
  toOpenAIUsage,
  toOpenAIUsageFromGeminiUsageMetadata,
} from '@/modules/proxy-gateway/antigravity/OpenAIUsageMapper';
import {
  type GeminiResponsesGroundingMetadata,
  type GeminiResponsesStreamPart,
  OpenAIResponsesStreamingMapper,
} from '@/modules/proxy-gateway/antigravity/OpenAIResponsesStreamingMapper';
import { ClaudeRequest, ClaudeResponse } from '@/modules/proxy-gateway/antigravity/types';
import { normalizeObjectJsonSchema } from '@/modules/proxy-gateway/antigravity/JsonSchemaUtils';
import {
  extractCustomToolInput,
  isCustomToolCall,
  toCustomToolArguments,
} from '@/modules/proxy-gateway/antigravity/CustomToolCall';
import { optimizeApplyPatch } from '@/modules/proxy-gateway/antigravity/ApplyPatchPreflight';
import {
  flattenOpenAITools,
  splitNamespaceToolName,
} from '@/modules/proxy-gateway/antigravity/ToolNamespace';
import { resolveShellToolName } from '@/modules/proxy-gateway/antigravity/ShellToolName';
import { sanitizeSystemInstructionForCache } from '@/modules/proxy-gateway/antigravity/StablePromptPrefix';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { decodeSignature } from '@/modules/proxy-gateway/antigravity/signature-utils';
import { decodeInternalSseData } from '@/modules/proxy-gateway/antigravity/internal-sse';
import {
  AnthropicChatRequest,
  AnthropicContent,
  GeminiRequest,
  GeminiResponse,
  GeminiUsageMetadata,
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
import { GeminiService } from '@/modules/proxy-gateway/server/modules/gemini/gemini.service';

export type OpenAIOutputProtocol = 'chat-completions' | 'responses';

@Injectable()
export class OpenAIService extends BaseProxyService {
  constructor(
    @Inject(AccountLeaseService) accountLeaseService: AccountLeaseService,
    @Inject(GeminiClient) geminiClient: GeminiClient,
    @Inject(GeminiService) private readonly geminiService: GeminiService,
  ) {
    super(accountLeaseService, geminiClient);
  }

  async handleChatCompletions(
    request: OpenAIChatRequest,
    outputProtocol: OpenAIOutputProtocol = 'chat-completions',
  ): Promise<OpenAIChatResponse | Observable<string>> {
    const appliedVariantRequest = applyOpenAIModelVariant(request);
    const routedRequest = appliedVariantRequest.request;
    const sessionKey = this.extractOpenAISessionKey(request);
    const clientToolNames = this.extractOpenAIToolNames(routedRequest.tools);

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
        const claudeRequest = this.convertOpenAIToClaude(accountRequest, sessionKey);
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
            const openaiResponse = this.convertClaudeToOpenAIResponse(
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
          return this.convertClaudeToOpenAIResponse(claudeResponse, request.model, clientToolNames);
        }
      } catch (err) {
        if (err instanceof Error && this.isProjectContextError(err.message)) {
          this.logger.warn(
            `OpenAI compatibility request hit project context issue, retrying without project: ${err.message}`,
          );
          try {
            const claudeRequest = this.convertOpenAIToClaude(accountRequest, sessionKey);
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
            return this.convertClaudeToOpenAIResponse(
              claudeResponse,
              request.model,
              clientToolNames,
            );
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
            const usageMetadata = this.toGeminiUsageMetadata(responsePayload.usageMetadata);
            if (usageMetadata) {
              mapper.setUsage(
                toOpenAIResponsesUsage(toOpenAIUsageFromGeminiUsageMetadata(usageMetadata)),
              );
            }
            const candidates = responsePayload.candidates;
            if (!Array.isArray(candidates)) {
              continue;
            }

            const candidate = this.toUnknownRecord(candidates[0]);
            const content = this.toUnknownRecord(candidate?.content);
            const parts = content?.parts;
            if (Array.isArray(parts)) {
              for (const part of parts) {
                const normalizedPart = this.toResponsesStreamPart(part);
                if (!normalizedPart) {
                  continue;
                }
                for (const event of mapper.processPart(normalizedPart)) {
                  subscriber.next(event);
                }
              }
            }

            const grounding = this.toResponsesGroundingMetadata(candidate?.groundingMetadata);
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

  private toResponsesStreamPart(value: unknown): GeminiResponsesStreamPart | null {
    const part = this.toUnknownRecord(value);
    if (!part) {
      return null;
    }

    const functionCallRecord = this.toUnknownRecord(part.functionCall);
    const functionName = isString(functionCallRecord?.name) ? functionCallRecord.name : null;
    const functionArgs = this.toUnknownRecord(functionCallRecord?.args) ?? {};
    const functionId = isString(functionCallRecord?.id) ? functionCallRecord.id : undefined;
    const inlineDataRecord = this.toUnknownRecord(part.inlineData);
    const inlineData =
      isString(inlineDataRecord?.mimeType) && isString(inlineDataRecord.data)
        ? {
            data: inlineDataRecord.data,
            mimeType: inlineDataRecord.mimeType,
          }
        : undefined;

    return {
      functionCall: functionName
        ? {
            args: functionArgs,
            id: functionId,
            name: functionName,
          }
        : undefined,
      inlineData,
      text: isString(part.text) ? part.text : undefined,
      thought: part.thought === true,
      thoughtSignature: isString(part.thoughtSignature) ? part.thoughtSignature : undefined,
      thought_signature: isString(part.thought_signature) ? part.thought_signature : undefined,
    };
  }

  private toResponsesGroundingMetadata(value: unknown): GeminiResponsesGroundingMetadata | null {
    const grounding = this.toUnknownRecord(value);
    if (!grounding) {
      return null;
    }

    const webSearchQueries = Array.isArray(grounding.webSearchQueries)
      ? grounding.webSearchQueries.filter(isString)
      : undefined;
    const groundingChunks = Array.isArray(grounding.groundingChunks)
      ? grounding.groundingChunks.flatMap((chunk) => {
          const web = this.toUnknownRecord(this.toUnknownRecord(chunk)?.web);
          if (!web) {
            return [];
          }
          return [
            {
              web: {
                title: isString(web.title) ? web.title : undefined,
                uri: isString(web.uri) ? web.uri : undefined,
              },
            },
          ];
        })
      : undefined;

    if (!webSearchQueries?.length && !groundingChunks?.length) {
      return null;
    }
    return { groundingChunks, webSearchQueries };
  }

  private toGeminiUsageMetadata(value: unknown): GeminiUsageMetadata | undefined {
    const usageMetadata = this.toUnknownRecord(value);
    if (!usageMetadata) {
      return undefined;
    }

    return {
      cachedContentTokenCount: isNumber(usageMetadata.cachedContentTokenCount)
        ? usageMetadata.cachedContentTokenCount
        : undefined,
      candidatesTokenCount: isNumber(usageMetadata.candidatesTokenCount)
        ? usageMetadata.candidatesTokenCount
        : undefined,
      promptTokenCount: isNumber(usageMetadata.promptTokenCount)
        ? usageMetadata.promptTokenCount
        : undefined,
      thoughtsTokenCount: isNumber(usageMetadata.thoughtsTokenCount)
        ? usageMetadata.thoughtsTokenCount
        : undefined,
      totalTokenCount: isNumber(usageMetadata.totalTokenCount)
        ? usageMetadata.totalTokenCount
        : undefined,
      total_input_tokens: isNumber(usageMetadata.total_input_tokens)
        ? usageMetadata.total_input_tokens
        : undefined,
      total_output_tokens: isNumber(usageMetadata.total_output_tokens)
        ? usageMetadata.total_output_tokens
        : undefined,
      total_cached_tokens: isNumber(usageMetadata.total_cached_tokens)
        ? usageMetadata.total_cached_tokens
        : undefined,
      total_thought_tokens: isNumber(usageMetadata.total_thought_tokens)
        ? usageMetadata.total_thought_tokens
        : undefined,
      totalThoughtTokens: isNumber(usageMetadata.totalThoughtTokens)
        ? usageMetadata.totalThoughtTokens
        : undefined,
      total_tokens: isNumber(usageMetadata.total_tokens) ? usageMetadata.total_tokens : undefined,
      total_tool_use_tokens: isNumber(usageMetadata.total_tool_use_tokens)
        ? usageMetadata.total_tool_use_tokens
        : undefined,
      cachedTokens: isNumber(usageMetadata.cachedTokens) ? usageMetadata.cachedTokens : undefined,
    };
  }

  private toUnknownRecord(value: unknown): Record<string, unknown> | null {
    if (!isPlainObject(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  // Handle SSE Stream conversion
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
            const usageMetadata = this.toGeminiUsageMetadata(responsePayload.usageMetadata);
            if (usageMetadata) {
              lastUsage = toOpenAIUsageFromGeminiUsageMetadata(usageMetadata);
            }

            const candidates = Array.isArray(responsePayload.candidates)
              ? responsePayload.candidates
              : [];
            for (const [candidateIndex, candidateValue] of candidates.entries()) {
              const candidate = this.toUnknownRecord(candidateValue);
              const content = this.toUnknownRecord(candidate?.content);
              const parts = Array.isArray(content?.parts) ? content.parts : [];
              // Keep these streams separate because clients can render thought text twice when
              // reasoning_content and content are present in the same delta.
              let reasoningContent = '';
              let responseContent = '';

              for (const partValue of parts) {
                const part = this.toUnknownRecord(partValue);
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

                const functionCall = this.toUnknownRecord(part.functionCall);
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
                  const rawArguments = this.toUnknownRecord(functionCall.args) ?? {};
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

                const inlineData = this.toUnknownRecord(part.inlineData);
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
                          : this.mapGeminiFinishReasonToOpenAIFinishReason(candidate.finishReason),
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
              this.parseOpenAIFunctionArguments(toolCall.function?.arguments ?? '{}'),
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
  private convertOpenAIToClaude(
    request: OpenAIChatRequest,
    signatureSessionKey?: string,
  ): ClaudeRequest {
    const messages = request.messages || [];
    const systemPromptParts: string[] = [];
    const seenSystemPromptKeys = new Set<string>();
    const anthropicMessages: ClaudeRequest['messages'] = [];
    const addSystemPrompt = (text: string) => {
      const trimmed = text.trim();
      const key = sanitizeSystemInstructionForCache(trimmed).split(/\s+/).join(' ');
      if (key && !seenSystemPromptKeys.has(key)) {
        seenSystemPromptKeys.add(key);
        systemPromptParts.push(trimmed);
      }
    };

    for (const msg of messages) {
      if (msg.role === 'system' || msg.role === 'developer') {
        const systemText = this.extractOpenAITextContent(msg.content);
        if (systemText) {
          addSystemPrompt(systemText);
        }
        continue;
      }

      if (msg.role === 'tool') {
        const toolResultText = this.extractOpenAITextContent(msg.content) || '';
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id || msg.name || `tool-result-${uuidv4()}`,
              content: toolResultText,
              is_error: false,
            },
          ],
        });
        continue;
      }

      const contentBlocks = this.convertOpenAIPartsToAnthropicContent(msg.content);

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        for (const toolCall of msg.tool_calls) {
          const functionName =
            toolCall.function?.name ??
            (toolCall.operation || toolCall.type === 'apply_patch_call' ? 'apply_patch' : null);
          if (!functionName) {
            continue;
          }
          contentBlocks.push({
            type: 'tool_use',
            id: toolCall.call_id || toolCall.id,
            name: functionName,
            input:
              toolCall.custom_input === undefined
                ? (toolCall.operation ??
                  this.parseOpenAIFunctionArguments(toolCall.function?.arguments ?? '{}'))
                : toCustomToolArguments(functionName, toolCall.custom_input),
          });
        }
      }

      anthropicMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: contentBlocks.length > 0 ? contentBlocks : '',
      });
    }

    const systemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join('\n') : undefined;

    return {
      model: request.model,
      messages: anthropicMessages,
      system: systemPrompt,
      tools: this.convertOpenAIToolsToAnthropicTools(request.tools),
      thinking: request.thinking
        ? {
            type: request.thinking.type ?? 'enabled',
            budget_tokens: request.thinking.budget_tokens,
            effort: request.thinking.effort,
          }
        : undefined,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      presence_penalty: request.presence_penalty,
      frequency_penalty: request.frequency_penalty,
      seed: request.seed,
      tool_choice: request.tool_choice,
      stream: request.stream,
      metadata: {
        ...(request.extra ?? {}),
        source: 'openai',
        signature_session_key: signatureSessionKey,
      },
    };
  }

  private convertOpenAIPartsToAnthropicContent(
    content: OpenAIChatRequest['messages'][number]['content'],
  ): AnthropicContent[] {
    if (isString(content)) {
      return content.trim() ? [{ type: 'text', text: content }] : [];
    }
    if (!Array.isArray(content)) {
      return [];
    }

    const blocks: AnthropicContent[] = [];
    for (const part of content) {
      if (part.type === 'text' && part.text) {
        blocks.push({ type: 'text', text: part.text });
        continue;
      }

      if (part.type === 'image_url' && part.image_url?.url) {
        const url = part.image_url.url;
        const dataUri = url.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/);
        if (dataUri?.groups?.mime && dataUri.groups.data) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: dataUri.groups.mime,
              data: dataUri.groups.data,
            },
          });
        } else {
          blocks.push({ type: 'text', text: `[image_url] ${url}` });
        }
      }
    }
    return blocks;
  }

  private extractOpenAITextContent(
    content: OpenAIChatRequest['messages'][number]['content'],
  ): string {
    if (isString(content)) {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .filter((part) => part.type === 'text')
      .map((part) => part.text || '')
      .join('\n');
  }

  private parseOpenAIFunctionArguments(argumentsString: string): Record<string, unknown> {
    if (isEmpty(argumentsString.trim())) {
      return {};
    }

    try {
      const parsed = JSON.parse(argumentsString);
      if (isPlainObject(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { raw: argumentsString };
    }
  }

  private extractOpenAIToolNames(tools: OpenAIChatRequest['tools']): ReadonlySet<string> {
    const names = new Set<string>();

    for (const tool of flattenOpenAITools(tools) ?? []) {
      const name = isString(tool.function?.name)
        ? tool.function.name
        : isString(tool.name)
          ? tool.name
          : undefined;
      if (name) {
        names.add(name);
      }
    }

    return names;
  }

  private convertOpenAIToolsToAnthropicTools(
    tools: OpenAIChatRequest['tools'],
  ): AnthropicChatRequest['tools'] {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    const result: NonNullable<AnthropicChatRequest['tools']> = [];
    const searchToolTypes = new Set([
      'web_search_20250305',
      'google_search',
      'google_search_retrieval',
      'builtin_web_search',
    ]);

    for (const tool of flattenOpenAITools(tools) ?? []) {
      if (!tool) {
        continue;
      }

      const toolType = isString(tool.type) ? tool.type.toLowerCase() : '';
      const functionName = isString(tool.function?.name)
        ? tool.function.name
        : isString(tool.name)
          ? tool.name
          : '';
      const normalizedFunctionName = functionName.toLowerCase();
      const isSearchTool =
        searchToolTypes.has(toolType) || searchToolTypes.has(normalizedFunctionName);

      if (isSearchTool) {
        result.push({
          name: functionName || 'builtin_web_search',
          type: 'web_search_20250305',
          input_schema: {
            type: 'object',
            properties: {},
          },
        });
        continue;
      }

      if (!functionName) {
        continue;
      }

      const parameters = isCustomToolCall(functionName)
        ? {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description:
                  'The exact freeform V4A patch text to pass to Codex apply_patch. It must start with *** Begin Patch and end with *** End Patch. Do not wrap it in a shell command or command array.',
              },
            },
            required: ['input'],
          }
        : (tool.function?.parameters ??
          (isPlainObject(tool.parameters)
            ? (tool.parameters as Record<string, unknown>)
            : {
                type: 'object',
                properties: {
                  content: {
                    type: 'string',
                    description: 'The raw content or patch to be applied',
                  },
                },
                required: ['content'],
              }));
      const inputSchema = normalizeObjectJsonSchema(parameters);

      result.push({
        name: functionName,
        description:
          tool.function?.description ?? (isString(tool.description) ? tool.description : undefined),
        input_schema: inputSchema,
      });
    }

    return result.length > 0 ? result : undefined;
  }

  private mapGeminiFinishReasonToOpenAIFinishReason(finishReason?: string): string | null {
    if (!finishReason) {
      return null;
    }

    const normalized = finishReason.toUpperCase();
    if (normalized === 'STOP') {
      return 'stop';
    }
    if (normalized === 'MAX_TOKENS') {
      return 'length';
    }
    if (normalized === 'SAFETY' || normalized === 'RECITATION') {
      return 'content_filter';
    }

    return finishReason.toLowerCase();
  }

  private mapAnthropicStopReasonToOpenAIFinishReason(stopReason?: string | null): string | null {
    if (!stopReason) {
      return null;
    }

    if (stopReason === 'end_turn') {
      return 'stop';
    }
    if (stopReason === 'max_tokens') {
      return 'length';
    }
    if (stopReason === 'tool_use') {
      return 'tool_calls';
    }

    return stopReason;
  }

  private normalizeToolCallArguments(input: unknown): string {
    if (isString(input)) {
      return input;
    }
    if (isNil(input)) {
      return '{}';
    }

    try {
      return JSON.stringify(input);
    } catch {
      return '{}';
    }
  }

  // Convert Claude response to OpenAI format
  private convertClaudeToOpenAIResponse(
    claudeResponse: ClaudeResponse,
    model: string,
    clientToolNames?: ReadonlySet<string>,
  ): OpenAIChatResponse {
    const contentBlocks = Array.isArray(claudeResponse?.content) ? claudeResponse.content : [];

    const textContent = contentBlocks
      .filter(
        (
          block,
        ): block is Extract<ClaudeResponse['content'][number], { type: 'text'; text: string }> =>
          block?.type === 'text',
      )
      .map((block) => block.text || '')
      .join('');

    const reasoningContent = contentBlocks
      .filter(
        (
          block,
        ): block is Extract<
          ClaudeResponse['content'][number],
          { type: 'thinking'; thinking: string }
        > => block?.type === 'thinking',
      )
      .map((block) => block.thinking || '')
      .join('');

    const toolCalls = contentBlocks
      .filter(
        (
          block,
        ): block is Extract<
          ClaudeResponse['content'][number],
          { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
        > => block?.type === 'tool_use',
      )
      .map((block, index: number) => {
        const splitName = splitNamespaceToolName(block.name || 'unknown_tool');
        const functionName = clientToolNames
          ? resolveShellToolName(splitName.name, clientToolNames)
          : splitName.name;
        const argumentsInput = isCustomToolCall(functionName)
          ? toCustomToolArguments(
              functionName,
              optimizeApplyPatch(extractCustomToolInput(functionName, block.input)).input,
            )
          : block.input;
        return {
          id: block.id || `tool-call-${index}`,
          type: 'function' as const,
          function: {
            name: functionName,
            arguments: this.normalizeToolCallArguments(argumentsInput),
          },
          namespace: splitName.namespace,
        };
      });

    return {
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: textContent || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            reasoning_content: reasoningContent || undefined,
            refusal: claudeResponse.refusal,
          },
          finish_reason: this.mapAnthropicStopReasonToOpenAIFinishReason(
            claudeResponse.stop_reason,
          ),
        },
      ],
      usage: toOpenAIUsage(claudeResponse.usage),
    };
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
