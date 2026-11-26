ALTER TABLE upstream_attempts ADD COLUMN account_generation_hash TEXT;
ALTER TABLE upstream_attempts ADD COLUMN usage_scope TEXT CHECK(usage_scope IN ('generation','non-generation'));
ALTER TABLE upstream_attempts ADD COLUMN input_tokens INTEGER;
ALTER TABLE upstream_attempts ADD COLUMN output_tokens INTEGER;
ALTER TABLE upstream_attempts ADD COLUMN cached_tokens INTEGER;
ALTER TABLE upstream_attempts ADD COLUMN reasoning_tokens INTEGER;
