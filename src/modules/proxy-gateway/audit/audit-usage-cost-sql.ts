import { sql, type SQLWrapper } from 'drizzle-orm';

interface AuditUsageCostFields {
  input: SQLWrapper;
  output: SQLWrapper;
  cache: SQLWrapper;
  cachedTokens: SQLWrapper;
  model: SQLWrapper;
  inputRate: SQLWrapper;
  outputRate: SQLWrapper;
  cachedRate: SQLWrapper;
}

export function auditUsageCost({
  input,
  output,
  cache,
  cachedTokens,
  model,
  inputRate,
  outputRate,
  cachedRate,
}: AuditUsageCostFields) {
  const useStandardRate = sql`${cachedRate} is null or ${cachedRate} = ${inputRate}`;
  return sql<number | null>`case
    when ${input} is not null and ${output} is not null and ${model} is not null
      and (${useStandardRate} or ${cachedTokens} is null or ${cache} <= ${input})
    then (
      (${input} - case when ${useStandardRate} then 0 else coalesce(${cache}, 0) end) * (1.0 * ${inputRate})
      + ${output} * (1.0 * ${outputRate})
      + case when ${useStandardRate} then 0 else coalesce(${cache}, 0) * (1.0 * ${cachedRate}) end
    ) / 1000000.0 end`;
}
