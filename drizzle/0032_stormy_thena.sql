CREATE TABLE `alliance_invites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`label` text,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`consumed_link_id` integer,
	`created_by` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`consumed_link_id`) REFERENCES `alliance_links`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alliance_invites_token_hash_unique` ON `alliance_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `alliance_invites_hash_idx` ON `alliance_invites` (`token_hash`);