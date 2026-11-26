import type Database from 'better-sqlite3';
import {
  and,
  between,
  count,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { requestLogs, upstreamAttempts } from './traffic-audit.schema';
import {
  UsageRangeResultSchema,
  UsageRangeTotalsSchema,
  type UsageRangeWorkerInput,
} from './usage-range.schema';

function flag(condition?: SQL): SQL<number> {
  return condition ? sql<number>`case when ${condition} then 1 else 0 end` : sql<number>`0`;
}

function sumOrZero(expression: SQLWrapper): SQL<number> {
  return sql<number>`coalesce(sum(${expression}), 0)`;
}

/** Each physical attempt contributes once; parent responses never supply account usage. */
export function readUsageRange(
  raw: Database.Database,
  {
    range,
    asOf,
    accountGenerationHash,
    accountSubjectHash,
    accountGrantHash,
  }: UsageRangeWorkerInput,
) {
  const orm = drizzle(raw);
  const attempt = upstreamAttempts;
  const request = requestLogs;
  const attemptModelMatches = inArray(attempt.model, range.modelIds);
  const subjectMatches =
    accountSubjectHash === null ? undefined : eq(attempt.accountSubjectHash, accountSubjectHash);
  const grantMatches =
    accountGrantHash === null ? undefined : eq(attempt.accountGrantHash, accountGrantHash);
  const generationMatches = eq(attempt.accountGenerationHash, accountGenerationHash);
  const compatibleGrant = or(grantMatches, isNull(attempt.accountGrantHash));
  const compatibleGeneration = or(generationMatches, isNull(attempt.accountGenerationHash));
  const identityMatches = subjectMatches ?? (grantMatches && and(generationMatches, grantMatches));
  const generationUsage = eq(attempt.usageScope, 'generation');
  const compatibleUsage = or(generationUsage, isNull(attempt.usageScope));
  const isModelRequest = eq(request.trafficClass, 'model');
  const withinRange = (timestamp: typeof request.timestamp | typeof attempt.timestamp) =>
    and(gte(timestamp, range.from), lt(timestamp, range.to), lte(timestamp, asOf));

  const physicalCandidates = orm
    .select({
      parentId: attempt.parentId,
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      cachedTokens: attempt.cachedTokens,
      responsePartial: attempt.responsePartial,
      identified: flag(identityMatches && and(generationUsage, identityMatches)).as('identified'),
      terminal: flag(
        and(
          isNotNull(attempt.completedAt),
          lte(attempt.completedAt, asOf),
          ne(attempt.outcome, 'in_progress'),
        ),
      ).as('terminal'),
    })
    .from(attempt)
    .innerJoin(request, eq(request.id, attempt.parentId))
    .where(
      and(
        attemptModelMatches,
        withinRange(attempt.timestamp),
        or(
          subjectMatches,
          and(
            eq(attempt.accountId, range.accountId),
            or(
              isNull(attempt.accountSubjectHash),
              accountSubjectHash === null ? grantMatches : undefined,
            ),
            compatibleGeneration,
            compatibleGrant,
          ),
        ),
        or(generationUsage, and(isNull(attempt.usageScope), isModelRequest)),
      ),
    );
  const hasParent = eq(attempt.parentId, request.id);
  const fallbackCandidates = orm
    .select({
      parentId: request.id,
      inputTokens: sql<number | null>`null`,
      outputTokens: sql<number | null>`null`,
      cachedTokens: sql<number | null>`null`,
      responsePartial: sql<boolean>`1`,
      identified: sql<number>`0`,
      terminal: sql<number>`0`,
    })
    .from(request)
    .where(
      and(
        isModelRequest,
        eq(request.attributedAccountId, range.accountId),
        inArray(request.physicalModel, range.modelIds),
        withinRange(request.timestamp),
        or(
          notExists(orm.select({ id: attempt.id }).from(attempt).where(hasParent)),
          exists(
            orm
              .select({ id: attempt.id })
              .from(attempt)
              .where(
                and(
                  hasParent,
                  compatibleUsage,
                  compatibleGeneration,
                  isNull(attempt.accountSubjectHash),
                  compatibleGrant,
                  or(eq(attempt.accountId, range.accountId), isNull(attempt.accountId)),
                  or(attemptModelMatches, isNull(attempt.model)),
                  or(isNull(attempt.accountId), isNull(attempt.model)),
                ),
              ),
          ),
        ),
      ),
    );
  const candidates = orm.$with('candidates').as(physicalCandidates.unionAll(fallbackCandidates));

  const hasMeasuredTokens = (
    tokens:
      | typeof candidates.inputTokens
      | typeof candidates.outputTokens
      | typeof candidates.cachedTokens,
  ) =>
    flag(
      and(
        eq(candidates.identified, 1),
        eq(candidates.terminal, 1),
        sql`typeof(${tokens}) = 'integer'`,
        between(tokens, 0, Number.MAX_SAFE_INTEGER),
      ),
    );
  const measured = orm.$with('measured').as(
    orm
      .select({
        parentId: candidates.parentId,
        inputTokens: candidates.inputTokens,
        outputTokens: candidates.outputTokens,
        cachedTokens: candidates.cachedTokens,
        responsePartial: candidates.responsePartial,
        identified: candidates.identified,
        hasInput: hasMeasuredTokens(candidates.inputTokens).as('has_input'),
        hasOutput: hasMeasuredTokens(candidates.outputTokens).as('has_output'),
        hasCached: hasMeasuredTokens(candidates.cachedTokens).as('has_cached'),
      })
      .from(candidates),
  );

  const partial = ne(measured.responsePartial, false);
  const requests = orm.$with('requests').as(
    orm
      .select({
        ambiguous: sql<number>`max(${eq(measured.identified, 0)})`.as('ambiguous'),
        missing:
          sql<number>`max(${or(eq(measured.hasInput, 0), eq(measured.hasOutput, 0), partial)})`.as(
            'missing',
          ),
        missingCached: sql<number>`max(${or(eq(measured.hasCached, 0), partial)})`.as(
          'missing_cached',
        ),
        inputTokens:
          sql<number>`sum(case when ${eq(measured.hasInput, 1)} then ${measured.inputTokens} else 0 end)`.as(
            'input_tokens',
          ),
        outputTokens:
          sql<number>`sum(case when ${eq(measured.hasOutput, 1)} then ${measured.outputTokens} else 0 end)`.as(
            'output_tokens',
          ),
        cachedTokens:
          sql<number>`sum(case when ${eq(measured.hasCached, 1)} then ${measured.cachedTokens} else 0 end)`.as(
            'cached_tokens',
          ),
      })
      .from(measured)
      .groupBy(measured.parentId),
  );
  const unambiguous = eq(requests.ambiguous, 0);
  const row = orm
    .with(candidates, measured, requests)
    .select({
      recordedRequests: count(),
      countedRequests: sumOrZero(sql`${and(unambiguous, eq(requests.missing, 0))}`),
      ambiguousRequests: sumOrZero(eq(requests.ambiguous, 1)),
      missingUsageRequests: sumOrZero(sql`${and(unambiguous, eq(requests.missing, 1))}`),
      missingCachedRequests: sumOrZero(sql`${and(unambiguous, eq(requests.missingCached, 1))}`),
      inputTokens: sumOrZero(requests.inputTokens),
      outputTokens: sumOrZero(requests.outputTokens),
      cachedTokens: sumOrZero(requests.cachedTokens),
    })
    .from(requests)
    .get();
  const totals = UsageRangeTotalsSchema.parse(row);
  return UsageRangeResultSchema.parse({
    ...range,
    asOf,
    ...totals,
    totalTokens: totals.inputTokens + totals.outputTokens,
    coverage: 'retained-local-records',
    accountIdentity: accountSubjectHash ? 'verified-google-account' : 'current-account-incarnation',
    timeBasis: 'attempt-start',
    ambiguousTimeBasis: 'attempt-start-or-unattributed-request-start',
  });
}
