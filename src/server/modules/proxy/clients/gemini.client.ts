import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { GeminiRequest, GeminiResponse } from '../interfaces/request-interfaces';
import { GeminiInternalRequest } from '../../../../lib/antigravity/types';

@Injectable()
export class GeminiClient {
  private readonly logger = new Logger(GeminiClient.name);
  // Default to v1beta for most features
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  async streamGenerate(model: string, content: GeminiRequest, accessToken: string): Promise<any> {
    const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`;

    try {
      const response = await axios.post(url, content, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout: 60000,
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(`Gemini Stream API Error: ${error.message}`);
        throw new Error(error.response?.data?.error?.message || error.message);
      }
      throw error;
    }
  }

  async generate(
    model: string,
    content: GeminiRequest,
    accessToken: string,
  ): Promise<GeminiResponse> {
    const url = `${this.baseUrl}/models/${model}:generateContent`;

    try {
      const response = await axios.post<GeminiResponse>(url, content, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000, // 60s timeout
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          `Gemini API Error: ${error.message} - ${JSON.stringify(error.response?.data)}`,
        );
        throw new Error(error.response?.data?.error?.message || error.message);
      }
      throw error;
    }
  }

  // --- Antigravity Internal API Support ---

  private readonly internalBaseUrl = 'https://cloudcode-pa.googleapis.com/v1internal';

  async streamGenerateInternal(body: GeminiInternalRequest, accessToken: string): Promise<any> {
    const url = `${this.internalBaseUrl}:streamGenerateContent?alt=sse`;
    try {
      const response = await axios.post(url, body, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/1.11.9 windows/amd64',
        },
        responseType: 'stream',
        timeout: 60000,
      });
      return response.data;
    } catch (error) {
      this.handleAxiosError(error, 'StreamInternal');
      throw error;
    }
  }

  async generateInternal(body: GeminiInternalRequest, accessToken: string): Promise<any> {
    const url = `${this.internalBaseUrl}:generateContent`;
    try {
      const response = await axios.post(url, body, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/1.11.9 windows/amd64',
        },
        timeout: 60000,
      });
      // v1internal API wraps the response in a 'response' field, unwrap it
      return response.data.response || response.data;
    } catch (error) {
      this.handleAxiosError(error, 'GenerateInternal');
      throw error;
    }
  }

  private handleAxiosError(error: any, context: string) {
    if (axios.isAxiosError(error)) {
      this.logger.error(
        `Gemini ${context} API Error: ${error.message} - ${JSON.stringify(error.response?.data)}`,
      );
      throw new Error(error.response?.data?.error?.message || error.message);
    }
    throw error;
  }
}
