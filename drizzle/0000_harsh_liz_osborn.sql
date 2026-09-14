CREATE TABLE `checks` (
	`id` text PRIMARY KEY NOT NULL,
	`pass_id` text NOT NULL,
	`household_id` text NOT NULL,
	`thing_id` text NOT NULL,
	`source` text NOT NULL,
	`endpoint` text NOT NULL,
	`ok` integer NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`error` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`pass_id` text,
	`finding_id` text,
	`thing_id` text,
	`interrupt_id` text,
	`interrupt_name` text,
	`kind` text NOT NULL,
	`question` text NOT NULL,
	`context` text,
	`options` text NOT NULL,
	`answer` text,
	`answer_note` text,
	`answered_at` integer,
	`resumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text,
	`actor` text NOT NULL,
	`ref_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`thing_id` text NOT NULL,
	`pass_id` text NOT NULL,
	`kind` text NOT NULL,
	`severity` text DEFAULT 'high' NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`source_url` text,
	`title` text NOT NULL,
	`consequence` text,
	`remedy` text,
	`component` text,
	`units_affected` integer,
	`confidence` real DEFAULT 1 NOT NULL,
	`match_reason` text,
	`raw` text,
	`state` text DEFAULT 'open' NOT NULL,
	`resolution_note` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`name` text NOT NULL,
	`place` text,
	`watch_state` text DEFAULT 'watching' NOT NULL,
	`last_pass_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `passes` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`things_checked` integer DEFAULT 0 NOT NULL,
	`sources_ok` integer DEFAULT 0 NOT NULL,
	`sources_failed` integer DEFAULT 0 NOT NULL,
	`rows_seen` integer DEFAULT 0 NOT NULL,
	`findings_new` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE TABLE `standing` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`thing_id` text,
	`text` text NOT NULL,
	`from_decision_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `things` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`make` text,
	`model` text,
	`year` integer,
	`identifier` text,
	`category` text,
	`acquired_at` integer,
	`second_hand` integer DEFAULT false NOT NULL,
	`note` text,
	`confidence` real DEFAULT 1 NOT NULL,
	`unknowns` text DEFAULT '[]' NOT NULL,
	`decoded` text,
	`added_via` text DEFAULT 'typed' NOT NULL,
	`added_at` integer NOT NULL,
	`retired_at` integer
);
