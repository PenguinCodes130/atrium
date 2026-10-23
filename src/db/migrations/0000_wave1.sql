CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `allowlist` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `allowlist_pattern_idx` ON `allowlist` (`pattern`);--> statement-breakpoint
CREATE TABLE `auth_rate_limit` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`window_start` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`step_up_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `two_factor` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`user_id` text NOT NULL,
	`verified` integer DEFAULT true,
	`failed_verification_count` integer DEFAULT 0,
	`locked_until` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `two_factor_user_idx` ON `two_factor` (`user_id`);--> statement-breakpoint
CREATE INDEX `two_factor_secret_idx` ON `two_factor` (`secret`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`role` text DEFAULT 'viewer' NOT NULL,
	`two_factor_enabled` integer DEFAULT false,
	`access_revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `secret` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`key` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`tag` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_owner_key_idx` ON `secret` (`owner_type`,`owner_id`,`key`);--> statement-breakpoint
CREATE TABLE `credential_link` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`integration_id`) REFERENCES `integration`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `custom_endpoint` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`record` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integration`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_endpoint_unique_idx` ON `custom_endpoint` (`integration_id`,`endpoint_id`);--> statement-breakpoint
CREATE TABLE `declarative_package` (
	`id` text PRIMARY KEY NOT NULL,
	`manifest` text NOT NULL,
	`endpoints` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `integration` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`secret_fields` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`last_health` text,
	`created_by` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `integration_package_idx` ON `integration` (`package_id`);--> statement-breakpoint
CREATE TABLE `package_problem` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`source` text NOT NULL,
	`reason` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`alerted_at` integer,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE TABLE `endpoint_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`params` text NOT NULL,
	`last_good` text,
	`last_attempt` text,
	`fetched_at` integer,
	`source_timestamp` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `endpoint_cache_integration_idx` ON `endpoint_cache` (`integration_id`);