import axios, { AxiosError, AxiosInstance } from 'axios';
import { QuotaData, Tier, LoadProjectResponse, QuotaApiResponse } from './types';
import { logger } from '../../utils/logger';

// Constants
const QUOTA_API_URL = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
const CLOUD_CODE_BASE_URL = 'https://cloudcode-pa.googleapis.com';
const USER_AGENT = 'antigravity/1.11.3 Darwin/arm64'; // Keeping the same UA as source

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
    const payload = { project: finalProjectId };
    const url = QUOTA_API_URL;
    const maxRetries = 3;

    logger.info(`Sending quota request to ${url}`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await client.post<QuotaApiResponse>(url, payload, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': USER_AGENT,
          },
        });

        const quotaResponse = response.data;
        const quotaData: QuotaData = {
          models: {},
          isForbidden: false,
          subscriptionTier: subscriptionTier,
        };

        logger.info(`Quota API returned ${Object.keys(quotaResponse.models || {}).length} models:`);

        if (quotaResponse.models) {
          for (const [name, info] of Object.entries(quotaResponse.models)) {
            logger.info(`   - ${name}`);
            if (info.quotaInfo) {
              const fraction = info.quotaInfo.remainingFraction ?? 0;
              const percentage = Math.floor(fraction * 100);
              const resetTime = info.quotaInfo.resetTime || '';

              // Only save models we care about
              if (name.includes('gemini') || name.includes('claude')) {
                quotaData.models[name] = { percentage, resetTime };
              }
            }
          }
        }

        return { quotaData, projectId: projectId };
      } catch (error: any) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          let text = '';
          try {
            text = JSON.stringify(error.response?.data || '');
          } catch {
            text = '[Unable to serialize response data]';
          }

          // ✅ Handle 403 Forbidden specifically - return immediately, do not retry
          if (status === 403) {
            logger.warn(`Account no permission (403 Forbidden), marked as forbidden`);
            return {
              quotaData: {
                models: {},
                isForbidden: true,
                subscriptionTier: subscriptionTier,
              },
              projectId: projectId,
            };
          }

          logger.warn(`API Error: ${status} - ${text} (Attempt ${attempt}/${maxRetries})`);
        } else {
          logger.warn(`Request Failed: ${error.message} (Attempt ${attempt}/${maxRetries})`);
        }

        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000));
        } else {
          throw new Error(`Quota query failed: ${error.message}`);
        }
      }
    }

    throw new Error('Unknown error in fetchQuota'); // Should not reach here
  }
}
