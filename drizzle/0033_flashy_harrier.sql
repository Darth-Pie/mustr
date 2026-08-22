-- IF NOT EXISTS (unlike drizzle-kit's usual plain CREATE TABLE) on purpose: the
-- rate limiter (server/rateLimit.ts) can self-create this same table on a
-- completely empty DB, before ensureSchema() has ever run — so this statement
-- must be safe to hit an already-existing table without failing the whole
-- schema-bootstrap batch.
CREATE TABLE IF NOT EXISTS `rate_limit_hits` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 1 NOT NULL
);
