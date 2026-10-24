CREATE TABLE `wow_characters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`region` text NOT NULL,
	`blizzard_id` integer NOT NULL,
	`realm_slug` text NOT NULL,
	`realm_name` text NOT NULL,
	`name` text NOT NULL,
	`class_id` integer NOT NULL,
	`class_name` text NOT NULL,
	`race_name` text NOT NULL,
	`faction` text NOT NULL,
	`level` integer NOT NULL,
	`item_level` integer,
	`guild_name` text,
	`gear` text,
	`followed` integer DEFAULT false NOT NULL,
	`is_main` integer DEFAULT false NOT NULL,
	`baseline_level` integer,
	`last_login_at` integer,
	`last_polled_at` integer,
	`last_validated_at` integer,
	`status_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wow_characters_region_blizzard_idx` ON `wow_characters` (`region`,`blizzard_id`);--> statement-breakpoint
CREATE INDEX `wow_characters_poll_idx` ON `wow_characters` (`followed`,`last_polled_at`);--> statement-breakpoint
CREATE INDEX `wow_characters_user_idx` ON `wow_characters` (`user_id`);--> statement-breakpoint
CREATE TABLE `wow_links` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`bnet_id` text NOT NULL,
	`battletag` text NOT NULL,
	`linked_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wow_links_bnet_id_unique` ON `wow_links` (`bnet_id`);--> statement-breakpoint
CREATE TABLE `wow_timeline` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` integer NOT NULL,
	`kind` text NOT NULL,
	`level` integer,
	`item_id` integer,
	`item_name` text,
	`item_quality` text,
	`item_level` integer,
	`slot` text,
	`tag` text,
	`guild_name` text,
	`badge_key` text,
	`seen_at` integer NOT NULL,
	`since_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `wow_characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `wow_timeline_character_idx` ON `wow_timeline` (`character_id`,`seen_at`);--> statement-breakpoint
ALTER TABLE `medals` ADD `auto_grant_rule` text;