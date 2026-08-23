CREATE TABLE `role_channels` (
	`role_id` integer NOT NULL,
	`channel_id` text NOT NULL,
	`channel_name` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`role_id`, `channel_id`),
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
