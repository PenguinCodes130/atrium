CREATE TABLE `credential` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`kind` text NOT NULL,
	`locked_origins` text DEFAULT '[]' NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_creator_name_idx` ON `credential` (`created_by_id`,`name_key`);--> statement-breakpoint
CREATE TABLE `integration_credential` (
	`integration_id` text NOT NULL,
	`secret_key` text NOT NULL,
	`credential_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`integration_id`, `secret_key`),
	FOREIGN KEY (`integration_id`) REFERENCES `integration`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `credential`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `integration_credential_cred_idx` ON `integration_credential` (`credential_id`);