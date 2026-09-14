CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`kind` text DEFAULT 'webhook' NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`level` text DEFAULT 'halt' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_at` integer,
	`last_ok` integer,
	`last_note` text,
	`created_at` integer NOT NULL
);
