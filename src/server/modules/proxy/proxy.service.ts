import { Injectable, Logger, Inject } from '@nestjs/common';
import { TokenManagerService } from './token-manager.service';
import { GeminiClient } from './clients/gemini.client';
import { v4 as uuidv4 } from 'uuid';
import { Observable } from 'rxjs';
import { transformClaudeRequestIn } from '../../../lib/antigravity/ClaudeRequestMapper';
import { transformResponse } from '../../../lib/antigravity/ClaudeResponseMapper';
import { StreamingState, PartProcessor } from '../../../lib/antigravity/ClaudeStreamingMapper';
import { ClaudeRequest } from '../../../lib/antigravity/types';
import {
  OpenAIChatRequest,
  AnthropicChatRequest,
  GeminiContent,
  GeminiPart,
  AnthropicSystemBlock,
  OpenAIContentPart,
  GeminiResponse,
  GeminiRequest,
  AnthropicChatResponse,
  OpenAIChatResponse,
  GeminiCandidate,
} from './interfaces/request-interfaces';

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);

  constructor(
    @Inject(TokenManagerService) private readonly tokenManager: TokenManagerService,
    @Inject(GeminiClient) private readonly geminiClient: GeminiClient,
  ) {}

  // --- Anthropic Handlers ---

  async handleAnthropicMessages(
    request: AnthropicChatRequest,
  ): Promise<AnthropicChatResponse | Observable<string>> {
    const targetModel = this.mapModel(request.model);
    this.logger.log(
      `Received Anthropic request for model: ${request.model} (Mapped: ${targetModel}, Stream: ${request.stream})`,
    );

    // Retry loop
    let lastError: unknown = null;
    const maxRetries = 3;

    for (let i = 0; i < maxRetries; i++) {
      const token = await this.tokenManager.getNextToken();
      if (!token) {
        throw new Error('No available accounts');
      }

      try {
        // Use Antigravity Mapper
        const projectId = token.token.project_id!;
        const geminiBody = transformClaudeRequestIn(request as unknown as ClaudeRequest, projectId);
        // Antigravity mapper determines the final model (e.g. gemini-2.5-flash) based on input
        // We trust its judgment (it handles logic for online/image models)

        if (request.stream) {
          const stream = await this.geminiClient.streamGenerateInternal(
            geminiBody,
            token.token.access_token,
          );
          return this.processAnthropicInternalStream(stream, geminiBody.model);
        } else {
          const response = await this.geminiClient.generateInternal(
            geminiBody,
            token.token.access_token,
          );
          return transformResponse(response) as unknown as AnthropicChatResponse;
        }
      } catch (error) {
        lastError = error;
        if (error instanceof Error) {
          this.logger.warn(`Anthropic Request failed: ${error.message}`);
          if (this.shouldRetry(error.message)) {
            this.tokenManager.markAsRateLimited(token.email);
          }
        }
      }
    }
    throw lastError || new Error('Request failed after retries');
  }

  // Old converter kept for reference or other uses
  private convertAnthropicToGemini(request: AnthropicChatRequest): GeminiRequest {
    const contents: GeminiContent[] = [];
    let systemInstruction: { parts: GeminiPart[] } | undefined = undefined;

    if (request.system) {
      let systemText = '';
      if (typeof request.system === 'string') {
        systemText = request.system;
      } else if (Array.isArray(request.system)) {
        systemText = request.system
          .filter((b: AnthropicSystemBlock) => b.type === 'text')
          .map((b: AnthropicSystemBlock) => b.text)
          .join('\n');
      }

      systemInstruction = {
        parts: [{ text: systemText }],
      };
    }

    // Anthropic 'messages' -> Gemini 'contents'
    for (const msg of request.messages) {
      const role = msg.role === 'user' ? 'user' : 'model';
      // Handle content arrays or strings
      let textPart = '';
      if (Array.isArray(msg.content)) {
        textPart = msg.content
          .filter((c) => c.type === 'text')
          .map((c) => (c as { type: 'text'; text: string }).text)
          .join('\n');
      } else {
        textPart = msg.content;
      }

      contents.push({
        role,
        parts: [{ text: textPart }],
      });
    }

    return {
      contents,
      systemInstruction,
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.max_tokens,
        topP: request.top_p,
        topK: request.top_k,
      },
    };
  }

  // Old response converter
  private convertGeminiToAnthropicResponse(
    geminiResponse: GeminiResponse,
    model: string,
  ): AnthropicChatResponse {
    const candidate = geminiResponse.candidates?.[0];
    const processed = this.processInlineData(candidate);
    const parts = processed?.content?.parts || [];
    const contentText = parts.map((p) => p.text || '').join('');

    return {
      id: `msg_${uuidv4()}`,
      type: 'message',
      role: 'assistant',
      model: model,
      content: [{ type: 'text', text: contentText }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
        output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
      },
    };
  }

  private processAnthropicInternalStream(upstreamStream: any, model: string): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';

      const state = new StreamingState();
      const processor = new PartProcessor(state);

      let lastFinishReason: string | undefined;
      let lastUsageMetadata: any | undefined;

      upstreamStream.on('data', (chunk: Buffer) => {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const json = JSON.parse(dataStr);

            if (json) {
              const startMsg = state.emitMessageStart(json);
              if (startMsg) subscriber.next(startMsg);
            }

            const candidate = json.candidates?.[0];
            const part = candidate?.content?.parts?.[0];

            if (candidate?.finishReason) {
              lastFinishReason = candidate.finishReason;
            }
            if (json.usageMetadata) {
              lastUsageMetadata = json.usageMetadata;
            }

            if (part) {
              const chunks = processor.process(part as any);
              chunks.forEach((c) => subscriber.next(c));
            }
          } catch (e) {
            this.logger.error('Stream parse error', e);
          }
        }
      });

      upstreamStream.on('end', () => {
        const finishChunks = state.emitFinish(lastFinishReason, lastUsageMetadata);
        finishChunks.forEach((c) => subscriber.next(c));
        subscriber.complete();
      });

      upstreamStream.on('error', (err: any) => subscriber.error(err));
    });
  }

  // --- OpenAI / Universal Handlers ---

  async handleChatCompletions(
    request: OpenAIChatRequest,
  ): Promise<OpenAIChatResponse | Observable<string>> {
    const targetModel = this.mapModel(request.model);
    this.logger.log(
      `Received request for model: ${request.model} (Mapped: ${targetModel}, Stream: ${request.stream})`,
    );

    // Retry loop for account selection
    let lastError: unknown = null;
    const maxRetries = 3;

    for (let i = 0; i < maxRetries; i++) {
      // 1. Get Token
      const token = await this.tokenManager.getNextToken();
      if (!token) {
        throw new Error('No available accounts (all exhausted or rate limited)');
      }

      try {
        // Convert OpenAI request to Claude format for Antigravity pipeline
        const claudeRequest = this.convertOpenAIToClaude(request);
        const projectId = token.token.project_id!;
        const geminiBody = transformClaudeRequestIn(
          claudeRequest as unknown as ClaudeRequest,
          projectId,
        );

        // Use v1internal API (same as Anthropic handler)
        if (request.stream) {
          const stream = await this.geminiClient.streamGenerateInternal(
            geminiBody,
            token.token.access_token,
          );
          return this.processStreamResponse(stream, request.model);
        } else {
          const response = await this.geminiClient.generateInternal(
            geminiBody,
            token.token.access_token,
          );
          this.logger.log(`Raw Gemini Response: ${JSON.stringify(response).substring(0, 500)}`);
          // Transform Gemini response to OpenAI format
          const claudeResponse = transformResponse(response);
          this.logger.log(`Claude Response: ${JSON.stringify(claudeResponse).substring(0, 500)}`);
          return this.convertClaudeToOpenAIResponse(claudeResponse, request.model);
        }
      } catch (error) {
        lastError = error;
        if (error instanceof Error) {
          this.logger.warn(`Request failed with account ${token.email}: ${error.message}`);

          // Check for rate limit / auth errors
          if (this.shouldRetry(error.message)) {
            this.tokenManager.markAsRateLimited(token.email);
          }
        }
      }
    }
    throw lastError || new Error('Request failed after retries');
  }

  // Handle SSE Stream conversion
  private processStreamResponse(upstreamStream: any, model: string): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';

      upstreamStream.on('data', (chunk: Buffer) => {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const json = JSON.parse(dataStr);
            const candidate = json.candidates?.[0];
            const contentPart = candidate?.content?.parts?.[0];
            const text = contentPart?.text || '';

            const openAICheck = {
              id: `chatcmpl-${uuidv4()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [
                {
                  index: 0,
                  delta: { content: text },
                  finish_reason: candidate?.finishReason ? 'stop' : null,
                },
              ],
            };

            subscriber.next(`data: ${JSON.stringify(openAICheck)}\n\n`);

            if (candidate?.finishReason) {
              subscriber.next('data: [DONE]\n\n');
              subscriber.complete();
            }
          } catch (e) {
            // ignore parse errors
          }
        }
      });

      upstreamStream.on('end', () => {
        subscriber.complete();
      });

      upstreamStream.on('error', (err: any) => {
        subscriber.error(err);
      });
    });
  }

  private convertOpenAIToGemini(request: OpenAIChatRequest): GeminiRequest {
    const contents: GeminiContent[] = [];
    let systemInstruction: { parts: GeminiPart[] } | undefined = undefined;

    // Extract system message
    const messages = request.messages || [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') {
          systemInstruction = {
            parts: [{ text: msg.content }],
          };
        }
      } else {
        let textPart = '';
        if (Array.isArray(msg.content)) {
          // OpenAI multimodal array
          textPart = msg.content
            .filter((p: OpenAIContentPart) => p.type === 'text')
            .map((p: OpenAIContentPart) => p.text || '')
            .join('\n');
        } else {
          textPart = msg.content;
        }

        contents.push({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: textPart }],
        });
      }
    }

    return {
      contents,
      systemInstruction,
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.max_tokens,
        topP: request.top_p,
      },
    };
  }

  private convertGeminiToOpenAIResponse(
    geminiResponse: GeminiResponse,
    model: string,
  ): OpenAIChatResponse {
    const candidate = geminiResponse.candidates?.[0];
    if (!candidate) throw new Error('No candidates in response');

    // Process response for images
    const processedCandidate = this.processInlineData(candidate);

    const parts = processedCandidate?.content?.parts || [];
    const content = parts.map((p) => p.text || '').join('');

    const finishReason =
      candidate?.finishReason === 'STOP'
        ? 'stop'
        : candidate?.finishReason?.toLowerCase() || 'stop';

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
            content: content,
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
        completion_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0,
      },
    };
  }

  // Convert Gemini inlineData (images) to Markdown
  private processInlineData(candidate: GeminiCandidate | undefined): GeminiCandidate | undefined {
    if (!candidate?.content?.parts) return candidate;

    const newParts = candidate.content.parts.map((part) => {
      if (part.inlineData) {
        const mimeType = part.inlineData.mimeType || 'image/jpeg';
        const data = part.inlineData.data || '';
        return {
          text: `\n\n![Generated Image](data:${mimeType};base64,${data})\n\n`,
        };
      }
      return part;
    });

    return {
      ...candidate,
      content: {
        ...candidate.content,
        parts: newParts,
      },
    };
  }

  // Convert OpenAI request format to Claude/Anthropic format
  private convertOpenAIToClaude(request: OpenAIChatRequest): AnthropicChatRequest {
    const messages = request.messages || [];
    let systemPrompt: string | undefined;
    const anthropicMessages: { role: string; content: string }[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Extract system message
        if (typeof msg.content === 'string') {
          systemPrompt = msg.content;
        }
      } else {
        let textContent = '';
        if (Array.isArray(msg.content)) {
          textContent = msg.content
            .filter((p: OpenAIContentPart) => p.type === 'text')
            .map((p: OpenAIContentPart) => p.text || '')
            .join('\n');
        } else {
          textContent = msg.content;
        }

        anthropicMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: textContent,
        });
      }
    }

    return {
      model: request.model,
      messages: anthropicMessages,
      system: systemPrompt,
      max_tokens: request.max_tokens || 4096,
      temperature: request.temperature,
      top_p: request.top_p,
      stream: request.stream,
    };
  }

  // Convert Claude response to OpenAI format
  private convertClaudeToOpenAIResponse(claudeResponse: any, model: string): OpenAIChatResponse {
    // Extract text content from Claude response
    const content =
      claudeResponse.content
        ?.filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('') || '';

    const finishReason =
      claudeResponse.stop_reason === 'end_turn'
        ? 'stop'
        : claudeResponse.stop_reason === 'max_tokens'
          ? 'length'
          : 'stop';

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
            content: content,
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: claudeResponse.usage?.input_tokens || 0,
        completion_tokens: claudeResponse.usage?.output_tokens || 0,
        total_tokens:
          (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0),
      },
    };
  }

  private mapModel(model: string): string {
    const lower = model.toLowerCase();
    if (lower.includes('sonnet') || lower.includes('thinking')) return 'gemini-3-pro-preview';
    if (lower.includes('haiku')) return 'gemini-2.0-flash-exp';
    if (lower.includes('opus')) return 'gemini-3-pro-preview';
    if (lower.includes('claude')) return 'gemini-2.5-flash-thinking';
    if (lower === 'gemini-3-pro-high' || lower === 'gemini-3-pro-low')
      return 'gemini-3-pro-preview';
    if (lower === 'gemini-3-flash') return 'gemini-3-flash-preview';

    // Default to original if no mapping found
    return model;
  }

  private shouldRetry(errorMessage: string): boolean {
    const msg = errorMessage.toLowerCase();
    if (
      msg.includes('404') ||
      msg.includes('not_found') ||
      msg.includes('403') ||
      msg.includes('permission_denied')
    )
      return true;
    if (
      msg.includes('429') ||
      msg.includes('resource_exhausted') ||
      msg.includes('quota') ||
      msg.includes('rate_limit')
    )
      return true;
    return false;
  }
}
