import axios, { AxiosInstance } from 'axios';
import { isNumber } from 'lodash-es';
import { QuotaData, LoadProjectResponse, QuotaApiResponse } from './types';
import { logger } from '@/shared/logging/logger';

// Constants
const QUOTA_API_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
] as const;
const CLOUD_CODE_BASE_URL = 'https://cloudcode-pa.googleapis.com';
const USER_AGENT = 'antigravity/1.11.3 Darwin/arm64'; // Keeping the same UA as source
const QUOTA_FALLBACK_DELAY_MS = 1000;

// Service Class
export class QuotaService {
  private static createClient(timeoutSecs: number = 15): AxiosInstance {
    return axios.create({
      timeout: timeoutSecs * 1000,
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Fetch Project ID and Subscription Type
   */
  private static async fetchProjectId(
    accessToken: string,
    email: string,
  ): Promise<[string | undefined, string | undefined]> {
    const client = this.createClient();
    const meta = { metadata: { ideType: 'ANTIGRAVITY' } };

    try {
      const res = await client.post<LoadProjectResponse>(
        `${CLOUD_CODE_BASE_URL}/v1internal:loadCodeAssist`,
        meta,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'antigravity/windows/amd64',
          },
        },
      );

      if (res.status >= 200 && res.status < 300) {
        const data = res.data;
        const projectId = data.cloudaicompanionProject;

        // Core logic: Preferentially get subscription ID from paid_tier
        const subscriptionTier = data.paidTier?.id || data.currentTier?.id;

        if (subscriptionTier) {
          logger.info(`📊 [${email}] Subscription Identified: ${subscriptionTier}`);
        }

        return [projectId, subscriptionTier];
      } else {
        logger.warn(`⚠️  [${email}] loadCodeAssist failed: Status: ${res.status}`);
      }
    } catch (error: any) {
      logger.error(`❌ [${email}] loadCodeAssist Network Error: ${error.message}`);
    }

    return [undefined, undefined];
  }

  /**
   * Unified entry point for querying account quota
   */
  public static async fetchQuota(accessToken: string, email: string) {
    return this.fetchQuotaInner(accessToken, email);
  }

  /**
   * Logic for querying account quota (Inner)
   */
  private static async fetchQuotaInner(
    accessToken: string,
    email: string,
  ): Promise<{ quotaData: QuotaData; projectId?: string }> {
    // 1. Get Project ID and Subscription Type
    const [projectId, subscriptionTier] = await this.fetchProjectId(accessToken, email);

    const finalProjectId = projectId;

    const client = this.createClient();
    const payload = finalProjectId ? { project: finalProjectId } : {};
    let lastError: Error | null = null;

    for (let endpointIndex = 0; endpointIndex < QUOTA_API_ENDPOINTS.length; endpointIndex++) {
      const endpoint = QUOTA_API_ENDPOINTS[endpointIndex];
      const hasNextEndpoint = endpointIndex + 1 < QUOTA_API_ENDPOINTS.length;
      logger.info(`Sending quota request to ${endpoint}`);

      let currentPayload = payload;
      let retriedWithoutProject = false;

      while (true) {
        try {
          const response = await client.post<QuotaApiResponse>(endpoint, currentPayload, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'User-Agent': USER_AGENT,
            },
          });

          const quotaResponse = response.data;
          const quotaData = this.toQuotaData(quotaResponse, subscriptionTier);

          if (endpointIndex > 0) {
            logger.info(`Quota API fallback succeeded at endpoint #${endpointIndex + 1}`);
          }

          return { quotaData, projectId };
        } catch (error: any) {
          let shouldFallback = true;

          if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            let responseBodyText = '';
            try {
              responseBodyText = JSON.stringify(error.response?.data || '');
            } catch {
              responseBodyText = '[Unable to serialize response data]';
            }

            // ✅ Handle 403 Forbidden specifically - return immediately, do not retry
            if (status === 403) {
              if (!retriedWithoutProject && 'project' in currentPayload) {
                logger.warn('Quota API returned 403 with project ID, retrying without project ID');
                currentPayload = {};
                retriedWithoutProject = true;
                continue;
              }

              logger.warn(
                'Quota API returned 403 without project fallback; marking account as forbidden',
              );
              return {
                quotaData: this.createForbiddenQuotaData(subscriptionTier),
                projectId,
              };
            }

            if (hasNextEndpoint && this.shouldFallbackQuotaStatus(status)) {
              logger.warn(
                `Quota API ${endpoint} returned ${status}, falling back to next endpoint`,
              );
              lastError = new Error(`HTTP ${status} - ${responseBodyText}`);
              await this.waitBeforeNextQuotaEndpoint();
              break;
            }

            logger.warn(`Quota API returned ${status}: ${responseBodyText}`);
            lastError = new Error(`HTTP ${status} - ${responseBodyText}`);
            shouldFallback = !isNumber(status);
          } else {
            logger.warn(`Quota API request failed at ${endpoint}: ${error.message}`);
            lastError = error instanceof Error ? error : new Error(String(error));
          }

          if (hasNextEndpoint && shouldFallback) {
            logger.warn(`Quota API request failed at ${endpoint}, falling back to next endpoint`);
            await this.waitBeforeNextQuotaEndpoint();
            break;
          } else {
            throw lastError ?? new Error(`Quota query failed: ${error.message}`);
          }
        }
      }
    }

    throw lastError ?? new Error('Unknown error in fetchQuota');
  }

  private static toQuotaData(
    quotaResponse: QuotaApiResponse,
    subscriptionTier: string | undefined,
  ): QuotaData {
    const quotaData: QuotaData = {
      models: {},
      isForbidden: false,
      subscriptionTier,
    };

    logger.info(`Quota API returned ${Object.keys(quotaResponse.models || {}).length} models:`);

    if (!quotaResponse.models) {
      return quotaData;
    }

    for (const [modelName, modelInfo] of Object.entries(quotaResponse.models)) {
      logger.info(`   - ${modelName}`);
      if (!modelInfo.quotaInfo) {
        continue;
      }

      const remainingFraction = modelInfo.quotaInfo.remainingFraction ?? 0;
      const percentage = Math.floor(remainingFraction * 100);
      const resetTime = modelInfo.quotaInfo.resetTime || '';

      // Only save models we care about, filtering out old versions (< 3.0)
      const isGeminiModel = modelName.includes('gemini');
      const isClaudeModel = modelName.includes('claude');
      const isLegacyGeminiModel = /gemini-[12](\.|$|-)/.test(modelName);

      if ((isGeminiModel || isClaudeModel) && !isLegacyGeminiModel) {
        quotaData.models[modelName] = { percentage, resetTime };
      }
    }

    return quotaData;
  }

  private static createForbiddenQuotaData(subscriptionTier: string | undefined): QuotaData {
    return {
      models: {},
      isForbidden: true,
      subscriptionTier,
    };
  }

  private static shouldFallbackQuotaStatus(status: unknown): boolean {
    return status === 429 || (isNumber(status) && status >= 500);
  }

  private static async waitBeforeNextQuotaEndpoint(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, QUOTA_FALLBACK_DELAY_MS);
    });
  }
}
