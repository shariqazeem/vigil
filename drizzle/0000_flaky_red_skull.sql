CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`service_id` text NOT NULL,
	`op` text NOT NULL,
	`risk` text NOT NULL,
	`input` text NOT NULL,
	`intent` text,
	`verdict` text NOT NULL,
	`rule` text NOT NULL,
	`reason` text NOT NULL,
	`command` text,
	`ok` integer,
	`output` text,
	`exit_code` integer,
	`ms` integer,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`incident_id` text,
	`interrupt_id` text,
	`kind` text NOT NULL,
	`question` text NOT NULL,
	`proposal` text,
	`because` text,
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
	`service_id` text NOT NULL,
	`incident_id` text,
	`kind` text NOT NULL,
	`detail` text,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`probe_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`severity` text DEFAULT 'down' NOT NULL,
	`symptom` text NOT NULL,
	`diagnosis` text,
	`suspect` text,
	`confidence` real,
	`resolution` text,
	`verified_by_reading_id` text,
	`opened_at` integer NOT NULL,
	`resolved_at` integer,
	`down_seconds` integer
);
--> statement-breakpoint
CREATE TABLE `probes` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`spec` text NOT NULL,
	`every_seconds` integer DEFAULT 300 NOT NULL,
	`failures_to_open` integer DEFAULT 2 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `readings` (
	`id` text PRIMARY KEY NOT NULL,
	`probe_id` text NOT NULL,
	`service_id` text NOT NULL,
	`ok` integer NOT NULL,
	`detail` text NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`incident_id` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`name` text NOT NULL,
	`matters` text,
	`host` text DEFAULT 'local' NOT NULL,
	`ssh_key` text,
	`repo` text,
	`process` text,
	`node_bin` text,
	`policy` text NOT NULL,
	`state` text DEFAULT 'watching' NOT NULL,
	`last_swept_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `standing` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`text` text NOT NULL,
	`from_decision_id` text,
	`created_at` integer NOT NULL
);
