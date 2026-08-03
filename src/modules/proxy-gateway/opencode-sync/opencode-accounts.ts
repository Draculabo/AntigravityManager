import { z } from 'zod';

const OpenCodePluginAccountSchema = z.object({
  email: z.string().nullish(),
  refreshToken: z.string(),
  projectId: z.string().nullish(),
  addedAt: z.number().int(),
  lastUsed: z.number().int(),
  rateLimitResetTimes: z.record(z.string(), z.number().int()).nullish(),
  managedProjectId: z.string().nullish(),
  enabled: z.boolean().nullish(),
  lastSwitchReason: z.string().nullish(),
  coolingDownUntil: z.number().int().nullish(),
  cooldownReason: z.string().nullish(),
  fingerprint: z.unknown().optional(),
  cachedQuota: z.unknown().optional(),
  cachedQuotaUpdatedAt: z.number().int().nullish(),
  fingerprintHistory: z.unknown().optional(),
});

const ExistingOpenCodeAccountsFileSchema = z.object({
  accounts: z.unknown().optional(),
  activeIndex: z.unknown().optional(),
  activeIndexByFamily: z.unknown().optional(),
});

export type OpenCodePluginAccount = z.infer<typeof OpenCodePluginAccountSchema>;

export interface OpenCodeSourceAccount {
  email: string;
  refreshToken: string;
  projectId?: string;
  lastUsed: number;
  disabled?: boolean;
  proxyDisabled?: boolean;
}

export interface OpenCodeAccountsFile {
  version: 3;
  accounts: OpenCodePluginAccount[];
  activeIndex: number;
  activeIndexByFamily: Record<string, number>;
}

export type OpenCodeAccountLoader = () => Promise<OpenCodeSourceAccount[]>;

function parseExistingAccountsFile(source: string | null): {
  accounts: OpenCodePluginAccount[];
  activeIndex: number;
  activeIndexByFamily: Record<string, number>;
} {
  if (!source) {
    return { accounts: [], activeIndex: 0, activeIndexByFamily: {} };
  }

  try {
    const parsed: unknown = JSON.parse(source);
    const result = ExistingOpenCodeAccountsFileSchema.safeParse(parsed);
    if (!result.success) {
      return { accounts: [], activeIndex: 0, activeIndexByFamily: {} };
    }

    return {
      accounts: (Array.isArray(result.data.accounts) ? result.data.accounts : []).flatMap(
        (account) => {
          const parsedAccount = OpenCodePluginAccountSchema.safeParse(account);
          return parsedAccount.success ? [parsedAccount.data] : [];
        },
      ),
      activeIndex:
        typeof result.data.activeIndex === 'number' && Number.isInteger(result.data.activeIndex)
          ? result.data.activeIndex
          : 0,
      activeIndexByFamily:
        typeof result.data.activeIndexByFamily === 'object' &&
        result.data.activeIndexByFamily !== null &&
        !Array.isArray(result.data.activeIndexByFamily)
          ? Object.fromEntries(
              Object.entries(result.data.activeIndexByFamily).filter(
                (entry): entry is [string, number] =>
                  typeof entry[1] === 'number' && Number.isInteger(entry[1]),
              ),
            )
          : {},
    };
  } catch {
    return { accounts: [], activeIndex: 0, activeIndexByFamily: {} };
  }
}

function clampIndex(index: number, accountCount: number): number {
  return accountCount > 0 ? Math.min(Math.max(index, 0), accountCount - 1) : 0;
}

/**
 * Build the OpenCode auth plugin v3 account file while retaining plugin-owned runtime state.
 */
export function buildOpenCodeAccountsFile(
  existingSource: string | null,
  sourceAccounts: readonly OpenCodeSourceAccount[],
  now: () => number = Date.now,
): OpenCodeAccountsFile {
  const existing = parseExistingAccountsFile(existingSource);
  const existingByRefreshToken = new Map(
    existing.accounts.map((account) => [account.refreshToken, account]),
  );
  const existingByEmail = new Map(
    existing.accounts.flatMap((account) =>
      account.email ? [[account.email, account] as const] : [],
    ),
  );

  const accounts = sourceAccounts
    .filter((account) => !account.disabled && !account.proxyDisabled)
    .map((account): OpenCodePluginAccount => {
      const previous =
        existingByRefreshToken.get(account.refreshToken) ?? existingByEmail.get(account.email);
      if (!previous) {
        return {
          email: account.email,
          refreshToken: account.refreshToken,
          ...(account.projectId !== undefined ? { projectId: account.projectId } : {}),
          addedAt: now(),
          lastUsed: account.lastUsed,
        };
      }

      return {
        email: account.email,
        refreshToken: account.refreshToken,
        ...(account.projectId !== undefined ? { projectId: account.projectId } : {}),
        addedAt: previous.addedAt,
        lastUsed: Math.max(previous.lastUsed, account.lastUsed),
        ...(previous.rateLimitResetTimes != null
          ? { rateLimitResetTimes: previous.rateLimitResetTimes }
          : {}),
        ...(previous.managedProjectId != null
          ? { managedProjectId: previous.managedProjectId }
          : {}),
        ...(previous.enabled != null ? { enabled: previous.enabled } : {}),
        ...(previous.lastSwitchReason != null
          ? { lastSwitchReason: previous.lastSwitchReason }
          : {}),
        ...(previous.coolingDownUntil != null
          ? { coolingDownUntil: previous.coolingDownUntil }
          : {}),
        ...(previous.cooldownReason != null ? { cooldownReason: previous.cooldownReason } : {}),
        ...(previous.fingerprint != null ? { fingerprint: previous.fingerprint } : {}),
        ...(previous.cachedQuota != null ? { cachedQuota: previous.cachedQuota } : {}),
        ...(previous.cachedQuotaUpdatedAt != null
          ? { cachedQuotaUpdatedAt: previous.cachedQuotaUpdatedAt }
          : {}),
        ...(previous.fingerprintHistory != null
          ? { fingerprintHistory: previous.fingerprintHistory }
          : {}),
      };
    });

  const activeIndex = clampIndex(existing.activeIndex, accounts.length);
  const activeIndexByFamily = Object.fromEntries(
    Object.entries(existing.activeIndexByFamily).map(([family, index]) => [
      family,
      clampIndex(index, accounts.length),
    ]),
  );
  activeIndexByFamily.claude ??= activeIndex;
  activeIndexByFamily.gemini ??= activeIndex;

  return {
    version: 3,
    accounts,
    activeIndex,
    activeIndexByFamily,
  };
}
