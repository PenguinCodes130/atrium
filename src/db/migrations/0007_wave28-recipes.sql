CREATE TABLE `read_check` (
	`integration_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`previous` text,
	`at` integer NOT NULL,
	PRIMARY KEY(`integration_id`, `endpoint_id`),
	FOREIGN KEY (`integration_id`) REFERENCES `integration`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recipe` (
	`id` text PRIMARY KEY NOT NULL,
	`record` text,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`problem` text,
	`skipped` text DEFAULT '[]' NOT NULL,
	`origin_integration_id` text,
	`created_by_id` text,
	`imported_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recipe_source_idx` ON `recipe` (`source`);