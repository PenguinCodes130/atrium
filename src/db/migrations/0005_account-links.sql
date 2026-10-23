CREATE TABLE `account_link` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`user_id` text,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	`revoked_cause` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_link_token_hash_unique` ON `account_link` (`token_hash`);--> statement-breakpoint
CREATE INDEX `account_link_email_idx` ON `account_link` (`email`);