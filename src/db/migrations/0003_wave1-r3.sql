CREATE TABLE `guest_link` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`pin_hash` text,
	`created_by` text NOT NULL,
	`created_by_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_cause` text,
	`revoked_by` text,
	`last_used_at` integer,
	`pin_fail_count` integer DEFAULT 0 NOT NULL,
	`pin_fail_window_start` integer,
	`pin_locked_until` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_link_token_hash_unique` ON `guest_link` (`token_hash`);--> statement-breakpoint
CREATE INDEX `guest_link_app_idx` ON `guest_link` (`app_id`);--> statement-breakpoint
CREATE INDEX `guest_link_creator_idx` ON `guest_link` (`created_by`);--> statement-breakpoint
CREATE TABLE `guest_session` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`link_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`link_id`) REFERENCES `guest_link`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_session_token_hash_unique` ON `guest_session` (`token_hash`);--> statement-breakpoint
CREATE INDEX `guest_session_link_idx` ON `guest_session` (`link_id`);--> statement-breakpoint
CREATE TABLE `control_run` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`control_id` text NOT NULL,
	`node_id` text NOT NULL,
	`by_kind` text NOT NULL,
	`by_user_id` text,
	`by_guest_link_id` text,
	`by_label` text,
	`at` integer NOT NULL,
	`input` text,
	`result` text NOT NULL,
	`message` text,
	`duration_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `control_run_app_idx` ON `control_run` (`app_id`,`at`);--> statement-breakpoint
CREATE TABLE `custom_command` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`command_id` text NOT NULL,
	`record` text,
	`draft` text,
	`updated_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integration`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_command_unique_idx` ON `custom_command` (`integration_id`,`command_id`);--> statement-breakpoint
ALTER TABLE `declarative_package` ADD `commands` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `declarative_package` ADD `draft_commands` text;--> statement-breakpoint
ALTER TABLE `integration` ADD `shared` integer DEFAULT false NOT NULL;