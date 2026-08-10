import { Inject, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';

import {
  type AnthropicChatRequest,
  type AnthropicChatResponse,
  type GeminiRequest,
  type GeminiResponse,
  type OpenAIChatRequest,
  type OpenAIChatResponse,
} from './common/interfaces/request-interfaces';
import { AnthropicService } from './modules/anthropic/anthropic.service';
import { GeminiService } from './modules/gemini/gemini.service';
import { OpenAIService, type OpenAIOutputProtocol } from './modules/openai/openai.service';

@Injectable()
export class ProxyService {
  constructor(
    @Inject(OpenAIService) private readonly openAIService: OpenAIService,
    @Inject(AnthropicService) private readonly anthropicService: AnthropicService,
    @Inject(GeminiService) private readonly geminiService: GeminiService,
  ) {}

  handleChatCompletions(
    request: OpenAIChatRequest,
    outputProtocol: OpenAIOutputProtocol = 'chat-completions',
  ): Promise<OpenAIChatResponse | Observable<string>> {
    return this.openAIService.handleChatCompletions(request, outputProtocol);
  }

  handleAnthropicMessages(
    request: AnthropicChatRequest,
  ): Promise<AnthropicChatResponse | Observable<string>> {
    return this.anthropicService.handleAnthropicMessages(request);
  }

  handleGeminiGenerateContent(model: string, request: GeminiRequest): Promise<GeminiResponse> {
    return this.geminiService.handleGeminiGenerateContent(model, request);
  }

  handleGeminiStreamGenerateContent(
    model: string,
    request: GeminiRequest,
  ): Promise<Observable<string>> {
    return this.geminiService.handleGeminiStreamGenerateContent(model, request);
  }
}
