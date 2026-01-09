import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CloudAccountRepo } from '../../../ipc/database/cloudHandler';
import { CloudAccount } from '../../../types/cloudAccount';
import { GoogleAPIService } from '../../../services/GoogleAPIService';

interface TokenData {
  email: string;
  account_id: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expiry_timestamp: number;
  project_id?: string;
  session_id?: string;
}

@Injectable()
export class TokenManagerService implements OnModuleInit {
  private readonly logger = new Logger(TokenManagerService.name);
  private currentIndex = 0;
  // In-memory cache of tokens with additional data
  private tokens: Map<string, TokenData> = new Map();
  // Cooldown map for rate-limited accounts
  private cooldowns: Map<string, number> = new Map();

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

      this.logger.log(`Loaded ${count} accounts`);
      return count;
    } catch (e) {
      this.logger.error('Failed to load accounts', e);
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
      expires_in: account.token.expires_in,
      expiry_timestamp: account.token.expiry_timestamp,
      project_id: account.token.project_id || undefined,
      session_id: account.token.session_id || this.generateSessionId(),
    };
  }

  private generateSessionId(): string {
    const min = 1_000_000_000_000_000_000n;
    const max = 9_000_000_000_000_000_000n;
    const range = max - min;
    const rand = BigInt(Math.floor(Math.random() * Number(range)));
    return (-(min + rand)).toString();
  }

  async getNextToken(): Promise<CloudAccount | null> {
    try {
      // Reload if empty
      if (this.tokens.size === 0) {
        await this.loadAccounts();
      }
      if (this.tokens.size === 0) return null;

      const now = Date.now();
      const nowSeconds = Math.floor(now / 1000);

      // Filter out accounts in cooldown
      const validTokens = Array.from(this.tokens.entries()).filter(([email, _]) => {
        const cooldownUntil = this.cooldowns.get(email);
        return !cooldownUntil || cooldownUntil <= now;
      });

      if (validTokens.length === 0) {
        this.logger.warn('All accounts are in cooldown');
        return null;
      }

      // Round robin selection
      const [accountId, tokenData] = validTokens[this.currentIndex % validTokens.length];
      this.currentIndex++;

      // Check if token needs refresh (expires in < 5 minutes)
      if (nowSeconds >= tokenData.expiry_timestamp - 300) {
        this.logger.log(`Token for ${tokenData.email} expiring soon, refreshing...`);
        try {
          const newTokens = await GoogleAPIService.refreshAccessToken(tokenData.refresh_token);

          // Update token data
          tokenData.access_token = newTokens.access_token;
          tokenData.expires_in = newTokens.expires_in;
          tokenData.expiry_timestamp = nowSeconds + newTokens.expires_in;

          // Save to DB
          await this.saveRefreshedToken(accountId, tokenData);
          this.tokens.set(accountId, tokenData);

          this.logger.log(`Token refreshed for ${tokenData.email}`);
        } catch (e) {
          this.logger.error(`Failed to refresh token for ${tokenData.email}`, e);
        }
      }

      // Resolve project ID if missing (mock for now, like original)
      if (!tokenData.project_id) {
        const mockId = `cloud-code-${Math.floor(Math.random() * 100000)}`;
        tokenData.project_id = mockId;
        await this.saveProjectId(accountId, mockId);
      }

      this.logger.log(`Selected account: ${tokenData.email}`);

      // Return in CloudAccount format for compatibility
      return {
        id: accountId,
        email: tokenData.email,
        token: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_in: tokenData.expires_in,
          expiry_timestamp: tokenData.expiry_timestamp,
          project_id: tokenData.project_id,
          session_id: tokenData.session_id,
        },
      } as CloudAccount;
    } catch (error) {
      this.logger.error('Failed to get token', error);
      return null;
    }
  }

  markAsRateLimited(email: string) {
    // Cooldown for 5 minutes
    const until = Date.now() + 5 * 60 * 1000;
    this.cooldowns.set(email, until);
    this.logger.warn(
      `Account ${email} marked as rate limited until ${new Date(until).toISOString()}`,
    );
  }

  resetCooldown(email: string) {
    this.cooldowns.delete(email);
  }

  private async saveRefreshedToken(accountId: string, tokenData: TokenData) {
    try {
      const acc = await CloudAccountRepo.getAccount(accountId);
      if (acc && acc.token) {
        const newToken = {
          ...acc.token,
          access_token: tokenData.access_token,
          expires_in: tokenData.expires_in,
          expiry_timestamp: tokenData.expiry_timestamp,
        };
        await CloudAccountRepo.updateToken(accountId, newToken);
      }
    } catch (e) {
      this.logger.error('Failed to save refreshed token to DB', e);
    }
  }

  private async saveProjectId(accountId: string, projectId: string) {
    try {
      const acc = await CloudAccountRepo.getAccount(accountId);
      if (acc && acc.token) {
        const newToken = {
          ...acc.token,
          project_id: projectId,
        };
        await CloudAccountRepo.updateToken(accountId, newToken);
      }
    } catch (e) {
      this.logger.error('Failed to save project ID to DB', e);
    }
  }

  /**
   * Get the number of loaded accounts (for status)
   */
  getAccountCount(): number {
    return this.tokens.size;
  }
}
