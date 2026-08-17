import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';

import { AccountLeaseService } from '../account-lease/account-lease.service';
import { GeminiClient } from '../gemini/gemini-client.service';

/**
 * Response headers worth handing back. A diagnostic exists to be compared against the vendor's
 * own answer, so the correlation ids come through; everything else upstream sets is dropped
 * rather than reflected blindly.
 */
const FORWARDED_HEADER_NAMES = new Set([
  'content-type',
  'retry-after',
  'x-cloud-trace-context',
  'x-goog-request-id',
  'x-request-id',
]);

export interface V1InternalPassthroughResult {
  accountEmail: string;
  accountId: string;
  body: string;
  headers: Record<string, string>;
  status: number;
}

@Injectable()
export class V1InternalPassthroughService {
  constructor(
    @Inject(AccountLeaseService) private readonly accountLeaseService: AccountLeaseService,
    @Inject(GeminiClient) private readonly geminiClient: GeminiClient,
  ) {}

  async forward(verb: string, body: unknown): Promise<V1InternalPassthroughResult> {
    const account = await this.accountLeaseService.getNextToken();
    if (!account) {
      throw new ServiceUnavailableException(
        'No eligible account is available for v1internal probing',
      );
    }

    const upstream = await this.geminiClient.postV1InternalRaw(
      verb,
      body,
      account.token.access_token,
      account.token.upstream_proxy_url,
    );

    return {
      accountEmail: account.email,
      accountId: account.id,
      body: upstream.body,
      headers: Object.fromEntries(
        Object.entries(upstream.headers).filter(([name]) =>
          FORWARDED_HEADER_NAMES.has(name.toLowerCase()),
        ),
      ),
      status: upstream.status,
    };
  }
}
