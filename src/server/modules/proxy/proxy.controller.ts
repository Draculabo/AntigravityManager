import {
  Controller,
  Post,
  Get,
  Body,
  Res,
  HttpStatus,
  UseGuards,
  Inject,
  Req,
  Logger,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { isNil } from 'lodash-es';
import { ProxyService } from './proxy.service';
import { Observable } from 'rxjs';
import {
  OpenAIChatRequest,
  AnthropicChatRequest,
  OpenAIChatResponse,
  OpenAIContentPart,
  GeminiRequest,
  GeminiResponse,
} from './interfaces/request-interfaces';
import { ProxyGuard } from './proxy.guard';
import {
  getAllDynamicModels,
  MODEL_LIST_CREATED_AT,
  MODEL_LIST_OWNER,
} from '../../../lib/antigravity/ModelMapping';
import { getServerConfig } from '../../server-config';



@Controller('v1')
@UseGuards(ProxyGuard)
export class ProxyController {
  private readonly logger = new Logger(ProxyController.name);

  constructor(@Inject(ProxyService) private readonly proxyService: ProxyService) { }

  @Get('models')
  listModels(@Res() res: FastifyReply) {
    try {
      const config = getServerConfig();
      const customMapping = config?.custom_mapping ?? {};
      const modelIds = getAllDynamicModels(customMapping);

      const data = modelIds.map((id) => ({
        id,
        object: 'model',
        created: MODEL_LIST_CREATED_AT,
        owned_by: MODEL_LIST_OWNER,
      }));

      res.status(HttpStatus.OK).send({
        object: 'list',
        data,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list models';
      this.logger.error(message, error instanceof Error ? error.stack : undefined);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
        error: {
          message,
          type: 'server_error',
        },
      });
    }
  }

  @Post('chat/completions')
  async chatCompletions(@Body() body: OpenAIChatRequest, @Res() res: FastifyReply) {
    await this.sendOpenAIChatCompletionResponse(body, res);
  }

  @Post('completions')
  async completions(
    @Body()
    body: {
      model?: string;
      prompt?: string | string[];
      max_tokens?: number;
      temperature?: number;
      top_p?: number;
      stream?: boolean;
    },
    @Res() res: FastifyReply,
  ) {
    const request: OpenAIChatRequest = {
      model: body.model ?? 'gemini-2.5-flash',
      messages: [
        {
          role: 'user',
          content: this.normalizePrompt(body.prompt),
        },
      ],
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stream: body.stream,
    };
    try {
      const result = await this.proxyService.handleChatCompletions(request);
      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result);
        return;
      }

      const response = result as OpenAIChatResponse;
      res.status(HttpStatus.OK).send(this.toLegacyCompletionsResponse(response));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      const status = this.resolveUpstreamStatus(message);
      this.logEndpointError('/v1/completions', status, message, error);
      res.status(status).send({
        error: {
          message,
          type: 'server_error',
        },
      });
    }
  }

  @Post('responses')
  async responses(
    @Body()
    body: {
      model?: string;
      instructions?: string;
      input?: unknown;
      max_output_tokens?: number;
      temperature?: number;
      top_p?: number;
      stream?: boolean;
    },
    @Res() res: FastifyReply,
  ) {
    const request = this.buildResponsesChatRequest(body);

    try {
      const result = await this.proxyService.handleChatCompletions(request);
      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result);
        return;
      }

      const response = result as OpenAIChatResponse;
      res.status(HttpStatus.OK).send(this.toLegacyCompletionsResponse(response));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      const status = this.resolveUpstreamStatus(message);
      this.logEndpointError('/v1/responses', status, message, error);
      res.status(status).send({
        error: {
          message,
          type: 'server_error',
        },
      });
    }
  }

  @Post('images/generations')
  async imageGenerations(
    @Body()
    body: {
      model?: string;
      prompt?: string;
      size?: string;
      quality?: string;
    },
    @Res() res: FastifyReply,
  ) {
    const request: OpenAIChatRequest = {
      model: body.model ?? 'gemini-3-pro-image',
      messages: [
        {
          role: 'user',
          content: body.prompt ?? '',
        },
      ],
      stream: false,
      size: body.size,
      quality: body.quality,
    };

    await this.sendOpenAIImageResponse(request, body.prompt ?? '', res);
  }

  @Post('images/edits')
  async imageEdits(
    @Body()
    body: {
      model?: string;
      prompt?: string;
      size?: string;
      quality?: string;
      image?: string | { data?: string; mimeType?: string };
      reference_images?: Array<string | { data?: string; mimeType?: string }>;
      mask?: string | { data?: string; mimeType?: string };
    },
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    if (!this.hasValidMultipartBoundary(req)) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .send('Invalid `boundary` for `multipart/form-data` request');
      return;
    }

    const imageParts = this.collectImageContentParts([
      body.image,
      body.mask,
      ...(body.reference_images ?? []),
    ]);

    const request: OpenAIChatRequest = {
      model: body.model ?? 'gemini-3-pro-image',
      messages: [
        {
          role: 'user',
          content:
            imageParts.length > 0
              ? [
                {
                  type: 'text',
                  text: body.prompt ?? 'Please edit this image based on the provided instruction.',
                },
                ...imageParts,
              ]
              : (body.prompt ?? 'Please edit this image based on the provided instruction.'),
        },
      ],
      stream: false,
      size: body.size,
      quality: body.quality,
    };

    await this.sendOpenAIImageResponse(request, body.prompt ?? '', res);
  }

  @Post('audio/transcriptions')
  async audioTranscriptions(
    @Body()
    body: {
      model?: string;
      prompt?: string;
      file?: string | { data?: string; mimeType?: string };
      audio?: string | { data?: string; mimeType?: string };
    },
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    if (!this.hasValidMultipartBoundary(req)) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .send('Invalid `boundary` for `multipart/form-data` request');
      return;
    }

    const inlineAudio = this.resolveInlineData(body.file ?? body.audio);
    if (!inlineAudio) {
      res.status(HttpStatus.BAD_REQUEST).send({
        error: {
          message: "Missing 'file' or 'audio' input. Provide base64 content or a data URL.",
          type: 'invalid_request_error',
        },
      });
      return;
    }

    try {
      const result = await this.proxyService.handleGeminiGenerateContent(
        body.model ?? 'gemini-2.5-flash',
        {
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: body.prompt ?? 'Please transcribe the provided speech audio accurately.',
                },
                {
                  inlineData: inlineAudio,
                },
              ],
            },
          ],
        },
      );

      const text = result.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('')
        .trim();

      res.status(HttpStatus.OK).send({
        text: text ?? '',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      const status = this.resolveUpstreamStatus(message);
      this.logEndpointError('/v1/audio/transcriptions', status, message, error);
      res.status(status).send({
        error: {
          message,
          type: 'server_error',
        },
      });
    }
  }

  private async sendOpenAIChatCompletionResponse(body: OpenAIChatRequest, res: FastifyReply) {
    try {
      const result = await this.proxyService.handleChatCompletions(body);

      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result);
        return;
      } else {
        res.status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      const status = this.resolveUpstreamStatus(message);
      this.logEndpointError('/v1/chat/completions', status, message, error);
      res.status(status).send({
        error: {
          message: message,
          type: 'server_error',
        },
      });
    }
  }

  @Post('messages')
  async anthropicMessages(@Body() body: AnthropicChatRequest, @Res() res: FastifyReply) {
    try {
      const result = await this.proxyService.handleAnthropicMessages(body);

      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result);
        return;
      } else {
        res.status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      const status = this.resolveUpstreamStatus(message);
      this.logEndpointError('/v1/messages', status, message, error);
      res.status(status).send({
        type: 'error',
        error: {
          type: 'api_error',
          message: message,
        },
      });
    }
  }

  private normalizePrompt(prompt: string | string[] | undefined): string {
    if (!prompt) {
      return '';
    }
    if (Array.isArray(prompt)) {
      return prompt.join('\n');
    }
    return prompt;
  }

  private toLegacyCompletionsResponse(response: OpenAIChatResponse): Record<string, unknown> {
    const choice = response.choices?.[0];
    const content = choice?.message?.content;
    const text = typeof content === 'string' ? content : '';

    return {
      id: response.id,
      object: 'text_completion',
      created: response.created,
      model: response.model,
      choices: [
        {
          text,
          index: choice?.index ?? 0,
          logprobs: null,
          finish_reason: choice?.finish_reason ?? null,
        },
      ],
      usage: response.usage,
    };
  }

  private normalizeResponsesInput(input: unknown): string {
    if (typeof input === 'string') {
      return input;
    }

    if (Array.isArray(input)) {
      return input
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }
          if (item && typeof item === 'object' && 'content' in item) {
            const content = (item as { content?: unknown }).content;
            if (typeof content === 'string') {
              return content;
            }
          }
          return JSON.stringify(item);
        })
        .join('\n');
    }

    if (isNil(input)) {
      return '';
    }

    return JSON.stringify(input);
  }

  private buildResponsesChatRequest(body: {
    model?: string;
    instructions?: string;
    input?: unknown;
    max_output_tokens?: number;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
  }): OpenAIChatRequest {
    const messages: OpenAIChatRequest['messages'] = [];
    if (body.instructions && body.instructions.trim() !== '') {
      messages.push({
        role: 'system',
        content: body.instructions,
      });
    }

    const callIdToToolName = new Map<string, string>();
    const inputItems = Array.isArray(body.input) ? body.input : null;

    if (inputItems) {
      for (const item of inputItems) {
        const itemObj = this.toRecord(item);
        if (!itemObj) {
          continue;
        }

        const type = this.asString(itemObj.type);
        if (!type) {
          continue;
        }

        if (type === 'function_call' || type === 'local_shell_call' || type === 'web_search_call') {
          const callId =
            this.asString(itemObj.call_id) ?? this.asString(itemObj.id) ?? `call_${Date.now()}`;
          const toolName =
            type === 'local_shell_call'
              ? 'shell'
              : type === 'web_search_call'
                ? 'google_search'
                : (this.asString(itemObj.name) ?? 'unknown');
          callIdToToolName.set(callId, toolName);
        }
      }

      for (const item of inputItems) {
        const itemObj = this.toRecord(item);
        if (!itemObj) {
          continue;
        }

        const type = this.asString(itemObj.type);
        if (!type) {
          continue;
        }

        if (type === 'message') {
          const role = this.asString(itemObj.role) ?? 'user';
          const content = this.normalizeResponsesMessageContent(itemObj.content);
          messages.push({ role, content });
          continue;
        }

        if (type === 'function_call' || type === 'local_shell_call' || type === 'web_search_call') {
          const callId =
            this.asString(itemObj.call_id) ?? this.asString(itemObj.id) ?? `call_${Date.now()}`;
          const toolName = callIdToToolName.get(callId) ?? 'unknown';
          const args = this.resolveToolArguments(type, itemObj);
          messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: callId,
                type: 'function',
                function: {
                  name: toolName,
                  arguments: JSON.stringify(args),
                },
              },
            ],
          });
          continue;
        }

        if (type === 'function_call_output' || type === 'custom_tool_call_output') {
          const callId = this.asString(itemObj.call_id) ?? this.asString(itemObj.id) ?? 'unknown';
          const output = itemObj.output;
          messages.push({
            role: 'tool',
            tool_call_id: callId,
            name: callIdToToolName.get(callId) ?? 'unknown',
            content: this.normalizeResponsesOutput(output),
          });
          continue;
        }
      }
    } else if (typeof body.input === 'string') {
      messages.push({
        role: 'user',
        content: body.input,
      });
    } else if (!isNil(body.input)) {
      messages.push({
        role: 'user',
        content: this.normalizeResponsesInput(body.input),
      });
    }

    if (messages.length === 0) {
      messages.push({
        role: 'user',
        content: '',
      });
    }

    return {
      model: body.model ?? 'gemini-2.5-flash',
      messages,
      max_tokens: body.max_output_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stream: body.stream,
    };
  }

  private normalizeResponsesMessageContent(content: unknown): string | OpenAIContentPart[] {
    if (typeof content === 'string') {
      return content;
    }

    if (!Array.isArray(content)) {
      return this.normalizeResponsesInput(content);
    }

    const textParts: string[] = [];
    const imageParts: OpenAIContentPart[] = [];

    for (const item of content) {
      const block = this.toRecord(item);
      if (!block) {
        continue;
      }

      const blockType = this.asString(block.type);
      if (blockType === 'input_text' || blockType === 'text' || blockType === 'output_text') {
        const text = this.asString(block.text);
        if (text) {
          textParts.push(text);
        }
        continue;
      }

      if (blockType === 'input_image' || blockType === 'image_url') {
        const imageUrl = this.resolveImageUrl(block);
        if (imageUrl) {
          imageParts.push({
            type: 'image_url',
            image_url: {
              url: imageUrl,
            },
          });
        }
      }
    }

    if (imageParts.length === 0) {
      return textParts.join('\n');
    }

    const merged: OpenAIContentPart[] = [];
    if (textParts.length > 0) {
      merged.push({
        type: 'text',
        text: textParts.join('\n'),
      });
    }
    merged.push(...imageParts);
    return merged;
  }

  private resolveToolArguments(
    type: string,
    item: Record<string, unknown>,
  ): Record<string, unknown> {
    if (type === 'local_shell_call') {
      const action = this.toRecord(item.action);
      const exec = action ? this.toRecord(action.exec) : null;
      const command = this.asString(exec?.command);
      return {
        command: command ? [command] : [],
      };
    }

    if (type === 'web_search_call') {
      const action = this.toRecord(item.action);
      return {
        query: this.asString(action?.query) ?? '',
      };
    }

    const raw = item.arguments;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        return {
          value: parsed,
        };
      } catch {
        return {
          raw,
        };
      }
    }

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }

    return {};
  }

  private normalizeResponsesOutput(output: unknown): string {
    if (typeof output === 'string') {
      return output;
    }
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      const obj = output as Record<string, unknown>;
      const content = this.asString(obj.content);
      if (content) {
        return content;
      }
    }
    if (isNil(output)) {
      return '';
    }
    return JSON.stringify(output);
  }

  private resolveImageUrl(block: Record<string, unknown>): string | null {
    const raw = block.image_url;
    if (typeof raw === 'string') {
      return raw;
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      const url = this.asString(record.url);
      if (url) {
        return url;
      }
    }
    return null;
  }

  private collectImageContentParts(
    entries: Array<string | { data?: string; mimeType?: string } | undefined>,
  ): OpenAIContentPart[] {
    const parts: OpenAIContentPart[] = [];
    for (const entry of entries) {
      const inlineData = this.resolveInlineData(entry);
      if (!inlineData) {
        continue;
      }
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${inlineData.mimeType};base64,${inlineData.data}`,
        },
      });
    }
    return parts;
  }

  private resolveInlineData(input: unknown): {
    mimeType: string;
    data: string;
  } | null {
    if (!input) {
      return null;
    }

    if (typeof input === 'string') {
      const dataUri = input.match(/^data:(?<mime>[^;]+);base64,(?<data>[A-Za-z0-9+/=]+)$/);
      if (dataUri?.groups?.mime && dataUri.groups.data) {
        return {
          mimeType: dataUri.groups.mime,
          data: dataUri.groups.data,
        };
      }

      const cleaned = input.replace(/\s+/g, '');
      if (cleaned.length > 0) {
        return {
          mimeType: 'audio/mpeg',
          data: cleaned,
        };
      }
      return null;
    }

    if (typeof input === 'object' && !Array.isArray(input)) {
      const obj = input as Record<string, unknown>;
      const data = this.asString(obj.data);
      if (!data) {
        return null;
      }
      return {
        mimeType: this.asString(obj.mimeType) ?? 'audio/mpeg',
        data,
      };
    }

    return null;
  }

  private toRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private isObservableLike(value: unknown): value is Observable<unknown> {
    return (
      Boolean(value) &&
      typeof value === 'object' &&
      typeof (value as { subscribe?: unknown }).subscribe === 'function'
    );
  }

  private writeSseResponse(res: FastifyReply, stream: Observable<unknown>): void {
    if (
      !res.raw ||
      typeof res.raw.writeHead !== 'function' ||
      typeof res.raw.write !== 'function'
    ) {
      res.header('Content-Type', 'text/event-stream');
      res.header('Cache-Control', 'no-cache');
      res.header('Connection', 'keep-alive');
      res.send(stream);
      return;
    }

    if (typeof (res as { hijack?: () => void }).hijack === 'function') {
      (res as { hijack: () => void }).hijack();
    }

    res.raw.writeHead(HttpStatus.OK, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const subscription = stream.subscribe({
      next: (chunk) => {
        if (res.raw.writableEnded) {
          return;
        }
        const payload = typeof chunk === 'string' ? chunk : String(chunk ?? '');
        res.raw.write(payload);
      },
      error: (error) => {
        if (res.raw.writableEnded) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        res.raw.write(
          `data: ${JSON.stringify({
            error: {
              message,
              type: 'server_error',
            },
          })}\n\n`,
        );
        res.raw.end();
      },
      complete: () => {
        if (!res.raw.writableEnded) {
          res.raw.end();
        }
      },
    });

    res.raw.on('close', () => {
      subscription.unsubscribe();
    });
  }

  private async sendOpenAIImageResponse(
    request: OpenAIChatRequest,
    prompt: string,
    res: FastifyReply,
  ): Promise<void> {
    try {
      const result = await this.proxyService.handleChatCompletions(request);
      if (result instanceof Observable) {
        this.logEndpointError(
          '/v1/images/generations',
          HttpStatus.INTERNAL_SERVER_ERROR,
          'Streaming image generation is not supported by this endpoint',
        );
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
          error: {
            message: 'Streaming image generation is not supported by this endpoint',
            type: 'invalid_request_error',
          },
        });
        return;
      }

      const content = result.choices?.[0]?.message?.content;
      const image = this.extractInlineBase64Image(typeof content === 'string' ? content : '');
      if (!image) {
        this.logEndpointError(
          '/v1/images/generations',
          HttpStatus.BAD_GATEWAY,
          'Upstream did not return inline image data',
        );
        res.status(HttpStatus.BAD_GATEWAY).send({
          error: {
            message: 'Upstream did not return inline image data',
            type: 'invalid_response_error',
          },
        });
        return;
      }

      res.status(HttpStatus.OK).send({
        created: Math.floor(Date.now() / 1000),
        data: [
          {
            b64_json: image.data,
          },
        ],
      });
    } catch (error) {
      let message = error instanceof Error ? error.message : 'Internal Server Error';

      if (this.isProjectContextErrorMessage(message)) {
        try {
          const geminiRequest = this.buildGeminiImageRequest(request, prompt);
          const geminiResult = await this.proxyService.handleGeminiGenerateContent(
            request.model ?? 'gemini-3-pro-image',
            geminiRequest,
          );
          const fallbackImage = this.extractInlineBase64ImageFromGeminiResponse(geminiResult);
          if (fallbackImage) {
            res.status(HttpStatus.OK).send({
              created: Math.floor(Date.now() / 1000),
              data: [
                {
                  b64_json: fallbackImage.data,
                },
              ],
            });
            return;
          }
          message = 'Upstream did not return inline image data';
        } catch (fallbackError) {
          message = fallbackError instanceof Error ? fallbackError.message : message;
        }
      }

      const status = this.resolveUpstreamStatus(message);
      this.logEndpointError('/v1/images/generations', status, message, error);
      res.status(status).send({
        error: {
          message,
          type: 'server_error',
        },
      });
    }
  }

  private extractInlineBase64Image(content: string): {
    mimeType: string;
    data: string;
  } | null {
    const pattern = /data:(?<mime>[\w/+.-]+);base64,(?<data>[A-Za-z0-9+/=]+)/;
    const matched = content.match(pattern);
    if (!matched || !matched.groups) {
      return null;
    }

    return {
      mimeType: matched.groups.mime,
      data: matched.groups.data,
    };
  }

  private extractInlineBase64ImageFromGeminiResponse(response: GeminiResponse): {
    mimeType: string;
    data: string;
  } | null {
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        return {
          mimeType: part.inlineData.mimeType ?? 'image/jpeg',
          data: part.inlineData.data,
        };
      }
      if (part.text) {
        const parsed = this.extractInlineBase64Image(part.text);
        if (parsed) {
          return parsed;
        }
      }
    }
    return null;
  }

  private buildGeminiImageRequest(
    request: OpenAIChatRequest,
    fallbackPrompt: string,
  ): GeminiRequest {
    const userMessage = request.messages.find((message) => message.role === 'user');
    const textParts: string[] = [];
    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

    if (!userMessage) {
      parts.push({ text: fallbackPrompt || 'Please generate an image based on this request.' });
    } else if (typeof userMessage.content === 'string') {
      parts.push({
        text: userMessage.content || fallbackPrompt || 'Please generate an image based on this request.',
      });
    } else {
      for (const block of userMessage.content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          textParts.push(block.text);
        }
        if (block.type === 'image_url') {
          const imageUrl = this.resolveImageUrl(block as unknown as Record<string, unknown>);
          const inlineData = this.resolveInlineData(imageUrl);
          if (inlineData) {
            parts.push({
              inlineData: {
                mimeType: inlineData.mimeType,
                data: inlineData.data,
              },
            });
          }
        }
      }
      if (textParts.length > 0) {
        parts.unshift({ text: textParts.join('\n') });
      }
    }

    if (parts.length === 0) {
      parts.push({ text: fallbackPrompt || 'Please generate an image based on this request.' });
    }

    return {
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
    };
  }

  private isProjectContextErrorMessage(message: string): boolean {
    const lowered = message.toLowerCase();
    return (
      lowered.includes('#3501') ||
      (lowered.includes('google cloud project') && lowered.includes('code assist license')) ||
      (lowered.includes('resource projects/') && lowered.includes('could not be found')) ||
      (lowered.includes('project') && lowered.includes('not found'))
    );
  }

  private hasValidMultipartBoundary(req: FastifyRequest): boolean {
    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string') {
      return false;
    }

    const lowered = contentType.toLowerCase();
    return lowered.includes('multipart/form-data') && lowered.includes('boundary=');
  }

  private resolveUpstreamStatus(message: string): HttpStatus {
    const lowered = message.toLowerCase();
    if (lowered.includes('all accounts failed or unhealthy')) {
      return HttpStatus.SERVICE_UNAVAILABLE;
    }
    if (lowered.includes('all accounts exhausted') || lowered.includes('no available accounts')) {
      return HttpStatus.TOO_MANY_REQUESTS;
    }
    if (
      lowered.includes('network socket disconnected') ||
      lowered.includes('secure tls connection was established') ||
      lowered.includes('socket hang up') ||
      lowered.includes('econnreset') ||
      lowered.includes('eai_again')
    ) {
      return HttpStatus.SERVICE_UNAVAILABLE;
    }
    if (lowered.includes('401') || lowered.includes('unauthorized')) {
      return HttpStatus.UNAUTHORIZED;
    }
    if (lowered.includes('403') || lowered.includes('forbidden')) {
      return HttpStatus.FORBIDDEN;
    }
    if (lowered.includes('429') || lowered.includes('rate limit') || lowered.includes('quota')) {
      return HttpStatus.TOO_MANY_REQUESTS;
    }
    if (lowered.includes('503') || lowered.includes('service unavailable')) {
      return HttpStatus.SERVICE_UNAVAILABLE;
    }
    if (lowered.includes('502') || lowered.includes('bad gateway')) {
      return HttpStatus.BAD_GATEWAY;
    }
    if (lowered.includes('504') || lowered.includes('timeout')) {
      return HttpStatus.GATEWAY_TIMEOUT;
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private logEndpointError(
    endpoint: string,
    status: HttpStatus,
    message: string,
    error?: unknown,
  ): void {
    const base = `[${endpoint}] status=${status} message=${message}`;
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(base, error instanceof Error ? error.stack : undefined);
      return;
    }
    this.logger.warn(base);
  }
}
