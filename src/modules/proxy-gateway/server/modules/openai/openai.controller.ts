import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Optional,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { isEmpty, isNil, isPlainObject, isString } from 'lodash-es';
import { Observable } from 'rxjs';
import {
  OpenAIChatRequest,
  OpenAIToolCall,
  OpenAIChatResponse,
  OpenAIContentPart,
  GeminiRequest,
  GeminiResponse,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import { toCustomToolArguments } from '@/modules/proxy-gateway/antigravity/CustomToolCall';
import { ApplyPatchFailureCompactor } from '@/modules/proxy-gateway/antigravity/ApplyPatchFailureCompaction';
import { toOpenAIResponsesResponse } from '@/modules/proxy-gateway/antigravity/OpenAIResponsesResponseMapper';
import {
  mergeOpenAIResponsesInputItems,
  OpenAIResponsesSessionStore,
  type OpenAIResponsesSession,
} from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.store';
import {
  getOpenAICompatibleModels,
  MODEL_LIST_CREATED_AT,
  MODEL_LIST_OWNER,
} from '@/modules/proxy-gateway/antigravity/ModelMapping';
import { getServerConfig } from '@/server/server-config';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
import {
  type ImageMonitoringRequest,
  type OpenAIImageResponse,
  summarizeImageRequest,
  summarizeImageResponse,
} from '@/modules/proxy-gateway/server/modules/openai/media/image-monitoring-summary';
import { parseImageMultipartRequest } from '@/modules/proxy-gateway/server/modules/openai/media/image-multipart-request';
import { safeStringifyPacket } from '@/shared/security/sensitiveDataMasking';
import { BaseProxyController } from '@/modules/proxy-gateway/server/common/base-proxy.controller';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { OpenAIService } from './openai.service';

export const IMAGE_QUOTA_REFRESH = Symbol('IMAGE_QUOTA_REFRESH');

export type ImageQuotaRefresh = () => Promise<void>;

export interface ResponsesRequestBody {
  model?: string;
  instructions?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  previous_response_id?: string;
  tools?: OpenAIChatRequest['tools'];
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  tool_choice?: OpenAIChatRequest['tool_choice'];
  stream?: boolean;
  user?: string;
}

export interface PreparedResponsesRequest {
  request: OpenAIChatRequest;
  session: OpenAIResponsesSession;
}

@Controller('v1')
@UseGuards(ProxyGuard)
export class OpenAIController extends BaseProxyController {
  constructor(
    @Inject(OpenAIService) private readonly proxyService: OpenAIService,
    @Optional()
    @Inject(AccountLeaseService)
    private readonly accountLeaseService?: AccountLeaseService,
    @Optional()
    @Inject(IMAGE_QUOTA_REFRESH)
    private readonly imageQuotaRefresh?: ImageQuotaRefresh,
  ) {
    super();
  }

  @Get('models')
  listModels(@Res() res: FastifyReply) {
    try {
      const config = getServerConfig();
      const customMapping = config?.custom_mapping ?? {};
      const onlyRawQuotaModels = config?.only_raw_quota_models ?? false;
      const dynamicModelIds = onlyRawQuotaModels
        ? this.accountLeaseService?.getAllRawQuotaModels()
        : this.accountLeaseService?.getAllCollectedModels();
      const modelIds = getOpenAICompatibleModels(
        customMapping,
        dynamicModelIds,
        onlyRawQuotaModels,
      );

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
    await this.respondOpenAIChatCompletions(body, res);
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
      model: body.model ?? 'gemini-3-flash',
      messages: [
        {
          role: 'user',
          content: this.normalizeCompletionPrompt(body.prompt),
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
      res.status(HttpStatus.OK).send(this.toLegacyTextCompletionsResponse(response));
    } catch (error) {
      this.sendOpenAIErrorResponse(res, '/v1/completions', error);
    }
  }

  @Post('responses')
  async responses(@Body() body: ResponsesRequestBody, @Res() res: FastifyReply) {
    const prepared = this.prepareResponsesRequest(body);
    if (!prepared) {
      res.status(HttpStatus.BAD_REQUEST).send({
        error: {
          message: `Unknown or expired previous_response_id: ${body.previous_response_id}`,
          type: 'invalid_request_error',
        },
      });
      return;
    }

    try {
      const result = await this.proxyService.handleChatCompletions(prepared.request, 'responses');
      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, this.cacheResponsesStream(result, prepared.session));
        return;
      }

      const response = result as OpenAIChatResponse;
      const responsesResponse = toOpenAIResponsesResponse(response);
      this.saveResponsesSession(responsesResponse, prepared.session);
      res.status(HttpStatus.OK).send(responsesResponse);
    } catch (error) {
      this.sendOpenAIErrorResponse(res, '/v1/responses', error);
    }
  }

  @Post('images/generations')
  async imageGenerations(
    @Body()
    body: ImageMonitoringRequest,
    @Res() res: FastifyReply,
  ) {
    const path = '/v1/images/generations';
    this.logImageMonitoringSummary('request', summarizeImageRequest(path, body));
    const request: OpenAIChatRequest = {
      model: body.model ?? 'gemini-3.1-flash-image',
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

    await this.sendOpenAIImageGenerationResponse(request, body.prompt ?? '', path, res);
  }

  @Post('images/edits')
  async imageEdits(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    const path = '/v1/images/edits';
    if (!this.hasMultipartBoundary(req)) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .send('Invalid `boundary` for `multipart/form-data` request');
      return;
    }
    let body: ImageMonitoringRequest;
    try {
      body = await parseImageMultipartRequest(req);
    } catch (error) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .send(error instanceof Error ? error.message : 'Invalid multipart request');
      return;
    }
    this.logImageMonitoringSummary('request', summarizeImageRequest(path, body));

    const imageParts = [
      ...this.collectImageContentParts([body.image, body.mask], 'image/png'),
      ...this.collectImageContentParts(body.reference_images ?? [], 'image/jpeg'),
    ];

    const request: OpenAIChatRequest = {
      model: body.model ?? 'gemini-3.1-flash-image',
      messages: [
        {
          role: 'user',
          content:
            imageParts.length > 0
              ? [
                  {
                    type: 'text',
                    text:
                      body.prompt ?? 'Please edit this image based on the provided instruction.',
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

    await this.sendOpenAIImageGenerationResponse(request, body.prompt ?? '', path, res);
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
    if (!this.hasMultipartBoundary(req)) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .send('Invalid `boundary` for `multipart/form-data` request');
      return;
    }

    const inlineAudio = this.resolveInlineData(body.file ?? body.audio, 'audio/mpeg');
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
        body.model ?? 'gemini-3-flash',
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
      this.sendOpenAIErrorResponse(res, '/v1/audio/transcriptions', error);
    }
  }

  private async respondOpenAIChatCompletions(body: OpenAIChatRequest, res: FastifyReply) {
    try {
      const result = await this.proxyService.handleChatCompletions(body);

      if (body.stream && this.isObservableLike(result)) {
        this.writeSseResponse(res, result);
        return;
      } else {
        res.status(HttpStatus.OK).send(result);
      }
    } catch (error) {
      this.sendOpenAIErrorResponse(res, '/v1/chat/completions', error);
    }
  }

  private normalizeCompletionPrompt(prompt: string | string[] | undefined): string {
    if (!prompt) {
      return '';
    }
    if (Array.isArray(prompt)) {
      return prompt.join('\n');
    }
    return prompt;
  }

  private toLegacyTextCompletionsResponse(response: OpenAIChatResponse): Record<string, unknown> {
    const choice = response.choices?.[0];
    const content = choice?.message?.content;
    const text = isString(content) ? content : '';

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

  public prepareResponsesRequest(body: ResponsesRequestBody): PreparedResponsesRequest | null {
    const currentInputItems = this.normalizeResponsesInputItems(body.input);
    const previousSession = body.previous_response_id
      ? OpenAIResponsesSessionStore.get(body.previous_response_id)
      : null;
    if (body.previous_response_id && !previousSession) {
      return null;
    }

    const inputItems = mergeOpenAIResponsesInputItems(
      previousSession?.inputItems ?? [],
      currentInputItems,
      previousSession?.toolCallItems,
    );
    const model = body.model ?? previousSession?.model ?? 'gemini-3-flash';
    const instructions = body.instructions ?? previousSession?.instructions;
    const tools = body.tools ?? previousSession?.tools;
    const request = this.buildResponsesChatRequest({
      ...body,
      input: inputItems,
      instructions,
      model,
      tools,
    });

    return {
      request,
      session: {
        inputItems,
        instructions,
        model,
        tools,
      },
    };
  }

  private normalizeResponsesInputItems(input: unknown): unknown[] {
    if (Array.isArray(input)) {
      return input;
    }
    if (isNil(input)) {
      return [];
    }

    const content = isString(input) ? input : this.normalizeResponsesInput(input);
    return [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: content }],
      },
    ];
  }

  private cacheResponsesStream(
    stream: Observable<unknown>,
    session: OpenAIResponsesSession,
  ): Observable<unknown> {
    return new Observable<unknown>((subscriber) => {
      const subscription = stream.subscribe({
        next: (event) => {
          this.saveResponsesSession(this.extractCompletedResponsesEvent(event), session);
          subscriber.next(event);
        },
        error: (error: unknown) => subscriber.error(error),
        complete: () => subscriber.complete(),
      });

      return () => subscription.unsubscribe();
    });
  }

  private extractCompletedResponsesEvent(event: unknown): unknown | null {
    if (!isString(event)) {
      return null;
    }

    const dataLine = event.split(/\r?\n/).find((line) => line.startsWith('data:'));
    if (!dataLine) {
      return null;
    }

    try {
      const parsed = this.toRecord(JSON.parse(dataLine.slice('data:'.length).trimStart()));
      return parsed?.type === 'response.completed' ? (parsed.response ?? null) : null;
    } catch {
      return null;
    }
  }

  private saveResponsesSession(response: unknown, session: OpenAIResponsesSession): void {
    const responseRecord = this.toRecord(response);
    const responseId = this.asString(responseRecord?.id);
    const output = responseRecord?.output;
    if (!responseId || !Array.isArray(output)) {
      return;
    }

    OpenAIResponsesSessionStore.save(responseId, {
      ...session,
      inputItems: [...session.inputItems, ...output],
    });
  }

  private normalizeResponsesInput(input: unknown): string {
    if (isString(input)) {
      return input;
    }

    if (Array.isArray(input)) {
      return input
        .map((item) => {
          if (isString(item)) {
            return item;
          }
          const itemRecord = this.toRecord(item);
          const content = this.asString(itemRecord?.content);
          if (content) {
            return content;
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

  private buildResponsesChatRequest(body: ResponsesRequestBody): OpenAIChatRequest {
    const messages: OpenAIChatRequest['messages'] = [];
    if (isString(body.instructions) && !isEmpty(body.instructions.trim())) {
      messages.push({
        role: 'system',
        content: body.instructions,
      });
    }

    const callIdToToolName = new Map<string, string>();
    const incompleteCustomCallIds = new Set<string>();
    const applyPatchFailureCompactor = new ApplyPatchFailureCompactor();
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

        if (
          type === 'function_call' ||
          type === 'local_shell_call' ||
          type === 'web_search_call' ||
          type === 'custom_tool_call'
        ) {
          const callId =
            this.asString(itemObj.call_id) ?? this.asString(itemObj.id) ?? `call_${Date.now()}`;
          if (
            type === 'custom_tool_call' &&
            this.asString(itemObj.status)?.toLowerCase() === 'incomplete'
          ) {
            incompleteCustomCallIds.add(callId);
            continue;
          }

          const toolName =
            type === 'local_shell_call'
              ? 'shell'
              : type === 'web_search_call'
                ? 'builtin_web_search'
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

        if (
          type === 'function_call' ||
          type === 'local_shell_call' ||
          type === 'web_search_call' ||
          type === 'custom_tool_call'
        ) {
          const callId =
            this.asString(itemObj.call_id) ?? this.asString(itemObj.id) ?? `call_${Date.now()}`;
          if (incompleteCustomCallIds.has(callId)) {
            continue;
          }

          const toolName = callIdToToolName.get(callId) ?? 'unknown';
          const customInput =
            type === 'custom_tool_call' ? (this.asString(itemObj.input) ?? '') : undefined;
          const args =
            customInput === undefined
              ? this.resolveToolArguments(type, itemObj)
              : toCustomToolArguments(toolName, customInput);
          const toolCall: OpenAIToolCall = {
            id: callId,
            type: 'function',
            function: {
              name: toolName,
              arguments: JSON.stringify(args),
            },
          };
          if (customInput !== undefined) {
            toolCall.custom_input = customInput;
          }
          messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [toolCall],
          });
          continue;
        }

        if (type === 'function_call_output' || type === 'custom_tool_call_output') {
          const callId = this.asString(itemObj.call_id) ?? this.asString(itemObj.id) ?? 'unknown';
          if (incompleteCustomCallIds.has(callId)) {
            continue;
          }
          if (type === 'custom_tool_call_output' && !callIdToToolName.has(callId)) {
            continue;
          }

          const toolName = callIdToToolName.get(callId) ?? 'unknown';
          const normalizedOutput = this.normalizeResponsesOutput(itemObj.output);
          const output =
            toolName === 'apply_patch'
              ? applyPatchFailureCompactor.compact(normalizedOutput)
              : normalizedOutput;
          messages.push({
            role: 'tool',
            tool_call_id: callId,
            name: toolName,
            content: output,
          });
          continue;
        }
      }
    } else if (isString(body.input)) {
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
      model: body.model ?? 'gemini-3-flash',
      messages,
      tools: body.tools,
      max_tokens: body.max_output_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      presence_penalty: body.presence_penalty,
      frequency_penalty: body.frequency_penalty,
      seed: body.seed,
      tool_choice: body.tool_choice,
      stream: body.stream,
      extra: {
        ...(body.metadata ?? {}),
        previous_response_id: body.previous_response_id,
        user_id: body.user,
      },
    };
  }

  private normalizeResponsesMessageContent(content: unknown): string | OpenAIContentPart[] {
    if (isString(content)) {
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
    if (isString(raw)) {
      try {
        const parsed = JSON.parse(raw);
        const parsedRecord = this.toRecord(parsed);
        if (parsedRecord) {
          return parsedRecord;
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

    const rawRecord = this.toRecord(raw);
    if (rawRecord) {
      return rawRecord;
    }

    return {};
  }

  private normalizeResponsesOutput(output: unknown): string {
    if (isString(output)) {
      return output;
    }
    const outputRecord = this.toRecord(output);
    const content = this.asString(outputRecord?.content);
    if (content) {
      return content;
    }
    if (isNil(output)) {
      return '';
    }
    return JSON.stringify(output);
  }

  private resolveImageUrl(block: Record<string, unknown>): string | null {
    const raw = block.image_url;
    if (isString(raw)) {
      return raw;
    }
    const rawRecord = this.toRecord(raw);
    const url = this.asString(rawRecord?.url);
    if (url) {
      return url;
    }
    return null;
  }

  private collectImageContentParts(
    entries: Array<string | { data?: string; mimeType?: string } | undefined>,
    defaultMimeType: string,
  ): OpenAIContentPart[] {
    const parts: OpenAIContentPart[] = [];
    for (const entry of entries) {
      const inlineData = this.resolveInlineData(entry, defaultMimeType);
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

  private resolveInlineData(
    input: unknown,
    defaultMimeType: string,
  ): {
    mimeType: string;
    data: string;
  } | null {
    if (!input) {
      return null;
    }

    if (isString(input)) {
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
          mimeType: defaultMimeType,
          data: cleaned,
        };
      }
      return null;
    }

    const inputRecord = this.toRecord(input);
    if (inputRecord) {
      const data = this.asString(inputRecord.data);
      if (!data) {
        return null;
      }
      return {
        mimeType: this.asString(inputRecord.mimeType) ?? defaultMimeType,
        data,
      };
    }

    return null;
  }

  private toRecord(value: unknown): Record<string, unknown> | null {
    if (!isPlainObject(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private asString(value: unknown): string | null {
    return isString(value) ? value : null;
  }

  private async sendOpenAIImageGenerationResponse(
    request: OpenAIChatRequest,
    prompt: string,
    path: '/v1/images/generations' | '/v1/images/edits',
    res: FastifyReply,
  ): Promise<void> {
    try {
      const result = await this.proxyService.handleChatCompletions(request);
      if (result instanceof Observable) {
        this.logProxyEndpointError(
          path,
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
      const image = this.extractInlineBase64Image(isString(content) ? content : '');
      if (!image) {
        this.logProxyEndpointError(
          path,
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

      const response: OpenAIImageResponse = {
        created: Math.floor(Date.now() / 1000),
        data: [
          {
            b64_json: image.data,
          },
        ],
      };
      this.logImageMonitoringSummary('response', summarizeImageResponse(response));
      this.scheduleImageQuotaRefresh();
      res.status(HttpStatus.OK).send(response);
    } catch (error) {
      let message = error instanceof Error ? error.message : 'Internal Server Error';
      let resolvedError = error;

      if (this.isProjectContextErrorMessage(message)) {
        try {
          const geminiRequest = this.buildGeminiImageRequest(request, prompt);
          const geminiResult = await this.proxyService.handleGeminiGenerateContent(
            request.model ?? 'gemini-3.1-flash-image',
            geminiRequest,
          );
          const fallbackImage = this.extractInlineBase64ImageFromGeminiResponse(geminiResult);
          if (fallbackImage) {
            const response: OpenAIImageResponse = {
              created: Math.floor(Date.now() / 1000),
              data: [
                {
                  b64_json: fallbackImage.data,
                },
              ],
            };
            this.logImageMonitoringSummary('response', summarizeImageResponse(response));
            this.scheduleImageQuotaRefresh();
            res.status(HttpStatus.OK).send(response);
            return;
          }
          message = 'Upstream did not return inline image data';
          resolvedError = new UpstreamRequestError({
            message,
            status: HttpStatus.BAD_GATEWAY,
          });
        } catch (fallbackError) {
          resolvedError = fallbackError;
          message = fallbackError instanceof Error ? fallbackError.message : message;
        }
      }

      this.sendOpenAIErrorResponse(res, path, resolvedError, message);
    }
  }

  private logImageMonitoringSummary(direction: 'request' | 'response', summary: unknown): void {
    this.logger.log(`[ImageMonitor] ${direction} ${safeStringifyPacket(summary)}`);
  }

  /**
   * Image requests can consume quota outside the regular account-lease refresh cadence.
   * Keep this asynchronous so a successful image response is never delayed by monitoring I/O.
   */
  private scheduleImageQuotaRefresh(): void {
    if (!this.imageQuotaRefresh) {
      return;
    }

    this.imageQuotaRefresh().catch((error: unknown) => {
      this.logger.warn('Failed to refresh quotas after image generation', error);
    });
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
    } else if (isString(userMessage.content)) {
      parts.push({
        text:
          userMessage.content ||
          fallbackPrompt ||
          'Please generate an image based on this request.',
      });
    } else if (Array.isArray(userMessage.content)) {
      for (const block of userMessage.content) {
        if (block.type === 'text' && isString(block.text) && !isEmpty(block.text.trim())) {
          textParts.push(block.text);
        }
        if (block.type === 'image_url') {
          const imageUrl = this.resolveImageUrl(block as unknown as Record<string, unknown>);
          const inlineData = this.resolveInlineData(imageUrl, 'image/png');
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
    } else {
      parts.push({ text: fallbackPrompt || 'Please generate an image based on this request.' });
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

  private hasMultipartBoundary(req: FastifyRequest): boolean {
    const contentType = req.headers['content-type'];
    if (!isString(contentType)) {
      return false;
    }

    const lowered = contentType.toLowerCase();
    return lowered.includes('multipart/form-data') && lowered.includes('boundary=');
  }
}
