CREATE TABLE `alliance_tournament_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`alliance_tournament_id` integer NOT NULL,
	`entry_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`created_by` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`alliance_tournament_id`) REFERENCES `alliance_tournaments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `alliance_tournament_entries_tournament_idx` ON `alliance_tournament_entries` (`alliance_tournament_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `alliance_tournament_entries_entry_idx` ON `alliance_tournament_entries` (`alliance_tournament_id`,`entry_id`);--> statement-breakpoint
CREATE TABLE `alliance_tournaments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`alliance_link_id` integer NOT NULL,
	`ref` text NOT NULL,
	`name` text NOT NULL,
	`format` text DEFAULT 'single_elim' NOT NULL,
	`competitor_type` text DEFAULT 'individual' NOT NULL,
	`status` text DEFAULT 'registration' NOT NULL,
	`starts_at` integer,
	`url` text,
	`registration_open` integer DEFAULT false NOT NULL,
	`standings` text,
	`champion` text,
	`closed` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`alliance_link_id`) REFERENCES `alliance_links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alliance_tournaments_link_ref_idx` ON `alliance_tournaments` (`alliance_link_id`,`ref`);--> statement-breakpoint
ALTER TABLE `tournament_entrants` ADD `origin_name` text;--> statement-breakpoint
ALTER TABLE `tournament_entrants` ADD `remote_ref` text;--> statement-breakpoint
CREATE UNIQUE INDEX `tournament_entrants_remote_ref_unique` ON `tournament_entrants` (`remote_ref`);--> statement-breakpoint
ALTER TABLE `tournaments` ADD `share_alliance` integer DEFAULT false NOT NULL;