// Without a reported cache count, estimate at the standard input rate.
export const auditUsageCostSql = `CASE
  WHEN input IS NOT NULL AND output IS NOT NULL AND prices.model IS NOT NULL
    AND (cached_rate IS NULL OR cached_rate=input_rate OR cached_tokens IS NULL OR cache<=input)
  THEN ((input - CASE WHEN cached_rate IS NULL OR cached_rate=input_rate THEN 0 ELSE COALESCE(cache,0) END) * (1.0 * input_rate)
    + output * (1.0 * output_rate)
    + CASE WHEN cached_rate IS NULL OR cached_rate=input_rate THEN 0 ELSE COALESCE(cache,0) * (1.0 * cached_rate) END) / 1000000.0
  END`;
