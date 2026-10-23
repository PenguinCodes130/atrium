CREATE TABLE `app_draft_change` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`rev` integer NOT NULL,
	`by` text NOT NULL,
	`at` integer NOT NULL,
	`ops` text NOT NULL,
	`summary` text NOT NULL,
	`settled` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `app_draft_change_app_idx` ON `app_draft_change` (`app_id`,`rev`);--> statement-breakpoint
CREATE TABLE `app_draft` (
	`app_id` text PRIMARY KEY NOT NULL,
	`rev` integer NOT NULL,
	`doc` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`from_import` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `app_version` (
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`doc` text NOT NULL,
	`published_by` text NOT NULL,
	`published_by_name` text DEFAULT '' NOT NULL,
	`published_at` integer NOT NULL,
	`note` text,
	`source` text NOT NULL,
	`restored_from` integer,
	PRIMARY KEY(`app_id`, `version`),
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `app` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`access_view` text NOT NULL,
	`access_edit` text NOT NULL,
	`access_guests` integer DEFAULT false NOT NULL,
	`published_version` integer,
	`draft_rev` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_slug_unique` ON `app` (`slug`);--> statement-breakpoint
CREATE INDEX `app_created_by_idx` ON `app` (`created_by`);--> statement-breakpoint
CREATE TABLE `library_component` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`tags` text NOT NULL,
	`version` integer NOT NULL,
	`contains_code` integer NOT NULL,
	`source` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `library_component_name_idx` ON `library_component` (`name`);--> statement-breakpoint
CREATE TABLE `library_version` (
	`component_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`tags` text NOT NULL,
	`node` text NOT NULL,
	`params` text NOT NULL,
	`contains_code` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`component_id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `setting` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE TABLE `theme_draft` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text,
	`patch` text NOT NULL,
	`created_by` text NOT NULL,
	`agent_name` text,
	`created_at` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`note` text,
	`decided_by_id` text,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `theme_draft_status_idx` ON `theme_draft` (`status`);--> statement-breakpoint
CREATE TABLE `theme` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`theme` text NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `theme_name_idx` ON `theme` (`name`);--> statement-breakpoint
CREATE TABLE `upload` (
	`id` text PRIMARY KEY NOT NULL,
	`file` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`kind` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upload_file_unique` ON `upload` (`file`);--> statement-breakpoint
CREATE INDEX `upload_sha_idx` ON `upload` (`sha256`);