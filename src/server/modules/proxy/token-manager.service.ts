import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CloudAccountRepo } from '../../../ipc/database/cloudHandler';
import { CloudAccount } from '../../../types/cloudAccount';
import { GoogleAPIService } from '../../../services/GoogleAPIService';

interface TokenData {
  email: string;
  account_id: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expiry_timestamp: number;
  project_id?: string;
  session_id?: string;
  upstream_proxy_url?: string;
}

function normalizeProjectId(projectId: string | null | undefined): string | undefined {
  if (typeof projectId !== 'string') {
    return undefined;
  }

  const trimmedProjectId = projectId.trim();
  if (trimmedProjectId === '' || /^cloud-code-\d+$/i.test(trimmedProjectId)) {
    return undefined;
  }

  // Legacy upgrades may carry malformed resource names (e.g. "projects/").
  // The internal gateway expects a plain project id, not a resource path.
  if (/^projects(?:\/.*)?$/i.test(trimmedProjectId)) {
    return undefined;
  }

  return trimmedProjectId;
}

@Injectable()
export class TokenManagerService implements OnModuleInit {
  private readonly logger = new Logger(TokenManagerService.name);
  private readonly defaultFallbackProjectId = 'silver-orbit-5m7qc';
  private currentIndex = 0;
  private readonly stickySessionTtlMs = 10 * 60 * 1000;
  private readonly rateLimitCooldownMs = 5 * 60 * 1000;
  private readonly forbiddenCooldownMs = 30 * 60 * 1000;
  // In-memory cache of tokens with additional data
  private tokens: Map<string, TokenData> = new Map();
  // Cooldown map for rate-limited accounts
  private cooldowns: Map<string, number> = new Map();
  private sessionBindings: Map<string, { accountId: string; expiresAt: number }> = new Map();

  async onModuleInit() {
    // Load accounts on module initialization
    await this.loadAccounts();
  }

  async loadAccounts(): Promise<number> {
    try {
      const accounts = await CloudAccountRepo.getAccounts();
      let count = 0;

      for (const account of accounts) {
        const tokenData = this.convertAccountToToken(account);
        if (tokenData) {
          this.tokens.set(account.id, tokenData);
          count++;
        }
      }

      this.logger.log(`Initialized token pool with ${count} accounts`);
      return count;
    } catch (e) {
      this.logger.error('Unable to load accounts', e);
      return 0;
    }
  }

  private convertAccountToToken(account: CloudAccount): TokenData | null {
    if (!account.token) return null;

    return {
      account_id: account.id,
      email: account.email,
      access_token: account.token.access_token,
      refresh_token: account.token.refresh_token,
      token_type: account.token.token_type || 'Bearer',
      expires_in: account.token.expires_in,
      expiry_timestamp: account.token.expiry_timestamp,
      project_id: account.token.project_id || undefined,
      session_id: account.token.session_id || this.generateSessionId(),
      upstream_proxy_url: account.token.upstream_proxy_url || undefined,
    };
  }

  private generateSessionId(): string {
    const min = 1_000_000_000_000_000_000n;
    const max = 9_000_000_000_000_000_000n;
    const range = max - min;
    const rand = BigInt(Math.floor(Math.random() * Number(range)));
    return (-(min + rand)).toString();
  }

  async getNextToken(options?: {
    sessionKey?: string;
    excludeAccountIds?: string[];
  }): Promise<CloudAccount | null> {
    try {
      // Reload if empty
      if (this.tokens.size === 0) {
        await this.loadAccounts();
      }
      if (this.tokens.size === 0) return null;

      const now = Date.now();
      const nowSeconds = Math.floor(now / 1000);
      const sessionKey = options?.sessionKey?.trim();
      const excludedAccountIds = new Set(options?.excludeAccountIds ?? []);

      this.clearExpiredSessionBindings(now);

      const fullTokenPool = Array.from(this.tokens.entries());
      const excludedFilteredTokens = fullTokenPool.filter(
        ([accountId]) => !excludedAccountIds.has(accountId),
      );
      const allTokens = excludedFilteredTokens.length > 0 ? excludedFilteredTokens : fullTokenPool;
      if (excludedFilteredTokens.length === 0 && excludedAccountIds.size > 0) {
        this.logger.warn(
          'Retry exclusions removed all accounts; temporarily reusing excluded accounts',
        );
      }

      // Filter out accounts in cooldown
      const validTokens = allTokens.filter(([accountId]) => {
        if (excludedAccountIds.has(accountId)) {
          return false;
        }

        const cooldownUntil = this.cooldowns.get(accountId);
        return !cooldownUntil || cooldownUntil <= now;
      });

      const candidateTokens = validTokens.length > 0 ? validTokens : allTokens;
      if (candidateTokens.length === 0) {
        this.logger.warn('No account available after applying exclusions');
        return null;
      }
      if (validTokens.length === 0) {
        this.logger.warn(
          'All accounts are currently in cooldown; temporarily bypassing cooldown to keep service available',
        );
      }

      if (sessionKey) {
        const stickyBinding = this.sessionBindings.get(sessionKey);
        if (stickyBinding && stickyBinding.expiresAt > now) {
          const stickyMatch = candidateTokens.find(
            ([accountId]) => accountId === stickyBinding.accountId,
          );
          if (stickyMatch) {
            const [stickyAccountId, stickyTokenData] = stickyMatch;
            return this.finalizeSelectedToken(
              stickyAccountId,
              stickyTokenData,
              nowSeconds,
              sessionKey,
            );
          }
        }
      }

      // Round robin selection
      const [accountId, tokenData] = candidateTokens[this.currentIndex % candidateTokens.length];
      this.currentIndex++;
      return this.finalizeSelectedToken(accountId, tokenData, nowSeconds, sessionKey);
    } catch (error) {
      this.logger.error('Unable to acquire token', error);
      return null;
    }
  }

  private async finalizeSelectedToken(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
    sessionKey?: string,
  ): Promise<CloudAccount | null> {
    try {
      let effectiveProjectId: string | undefined;

      // Check if token needs refresh (expires in < 5 minutes)
      if (nowSeconds >= tokenData.expiry_timestamp - 300) {
        this.logger.log(`Token for ${tokenData.email} is close to expiry; refreshing...`);
        try {
          const newTokens = await GoogleAPIService.refreshAccessToken(tokenData.refresh_token);

          // Update token data
          tokenData.access_token = newTokens.access_token;
          tokenData.expires_in = newTokens.expires_in;
          tokenData.expiry_timestamp = nowSeconds + newTokens.expires_in;

          // Save to DB
          await this.saveTokenState(accountId, tokenData);
          this.tokens.set(accountId, tokenData);

          this.logger.log(`Refreshed token for ${tokenData.email}`);
        } catch (e) {
          this.logger.error(`Unable to refresh token for ${tokenData.email}`, e);
        }
      }

      if (normalizeProjectId(tokenData.project_id) === undefined) {
        tokenData.project_id = undefined;
      }
      effectiveProjectId = tokenData.project_id;

      if (!effectiveProjectId) {
        try {
          const fetchedProjectId = await GoogleAPIService.fetchProjectId(tokenData.access_token);
          const normalizedProjectId = normalizeProjectId(fetchedProjectId);

          if (normalizedProjectId) {
            tokenData.project_id = normalizedProjectId;
            effectiveProjectId = normalizedProjectId;
            await this.saveTokenState(accountId, tokenData);
            this.tokens.set(accountId, tokenData);
            this.logger.log(`Resolved project ID for ${tokenData.email}: ${normalizedProjectId}`);
          } else {
            this.logger.warn(
              `Project ID is unavailable for ${tokenData.email}; request will continue without project context`,
            );
          }
        } catch (error) {
          this.logger.warn(`Failed to resolve project ID for ${tokenData.email}`, error);
        }
      }

      if (!effectiveProjectId) {
        const fallbackProjectId = this.getFallbackProjectId();
        effectiveProjectId = fallbackProjectId;
        this.logger.warn(
          `Using fallback project ID for ${tokenData.email} without persistence: ${fallbackProjectId}`,
        );
      }

      this.logger.log(`Using account: ${tokenData.email}`);
      if (sessionKey) {
        this.sessionBindings.set(sessionKey, {
          accountId,
          expiresAt: Date.now() + this.stickySessionTtlMs,
        });
      }

      // Return in CloudAccount format for compatibility
      const timestamp = Date.now();
      const cloudAccount: CloudAccount = {
        id: accountId,
        provider: 'google',
        email: tokenData.email,
        token: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          token_type: tokenData.token_type,
          expires_in: tokenData.expires_in,
          expiry_timestamp: tokenData.expiry_timestamp,
          project_id: effectiveProjectId,
          session_id: tokenData.session_id,
          upstream_proxy_url: tokenData.upstream_proxy_url,
        },
        created_at: timestamp,
        last_used: timestamp,
      };
      return cloudAccount;
    } catch (error) {
      this.logger.error('Unable to finalize selected token', error);
      return null;
    }
  }

  markAsRateLimited(accountIdOrEmail: string) {
    this.markInCooldown(accountIdOrEmail, 'rate limited', this.rateLimitCooldownMs);
  }

  markAsForbidden(accountIdOrEmail: string) {
    this.markInCooldown(accountIdOrEmail, 'forbidden', this.forbiddenCooldownMs);
  }

  private resolveAccountId(accountIdOrEmail: string): string | null {
    if (this.tokens.has(accountIdOrEmail)) {
      return accountIdOrEmail;
    }

    for (const [accountId, tokenData] of this.tokens.entries()) {
      if (tokenData.email === accountIdOrEmail) {
        return accountId;
      }
    }

    return null;
  }

  private clearExpiredSessionBindings(now: number): void {
    for (const [sessionKey, binding] of this.sessionBindings.entries()) {
      if (binding.expiresAt <= now) {
        this.sessionBindings.delete(sessionKey);
      }
    }
  }

  private markInCooldown(
    accountIdOrEmail: string,
    reason: 'rate limited' | 'forbidden',
    durationMs: number,
  ): void {
    const accountId = this.resolveAccountId(accountIdOrEmail) ?? accountIdOrEmail;
    const cooldownUntil = Date.now() + durationMs;

    this.cooldowns.set(accountId, cooldownUntil);
    this.logger.warn(
      `Account ${accountIdOrEmail} (cooldown key: ${accountId}) set to ${reason} until ${new Date(cooldownUntil).toISOString()}`,
    );
  }

  private async saveTokenState(accountId: string, tokenData: TokenData) {
    try {
      const acc = await CloudAccountRepo.getAccount(accountId);
      if (acc && acc.token) {
        const newToken = {
          ...acc.token,
          access_token: tokenData.access_token,
          expires_in: tokenData.expires_in,
          expiry_timestamp: tokenData.expiry_timestamp,
          project_id: tokenData.project_id ?? acc.token.project_id,
          session_id: tokenData.session_id ?? acc.token.session_id,
          upstream_proxy_url: tokenData.upstream_proxy_url ?? acc.token.upstream_proxy_url,
        };
        await CloudAccountRepo.updateToken(accountId, newToken);
      }
    } catch (e) {
      this.logger.error('Unable to persist token state to DB', e);
    }
  }

  /**
   * Get the number of loaded accounts (for status)
   */
  getAccountCount(): number {
    return this.tokens.size;
  }

  private getFallbackProjectId(): string {
    const fromEnv = process.env.PROXY_FALLBACK_PROJECT_ID?.trim();
    const normalizedFromEnv = normalizeProjectId(fromEnv);
    if (normalizedFromEnv) {
      return normalizedFromEnv;
    }
    return this.defaultFallbackProjectId;
  }
}
