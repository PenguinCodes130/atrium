CREATE TABLE `integration_service` (
	`integration_id` text PRIMARY KEY NOT NULL,
	`kind` text,
	`open_url` text,
	`headline` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integration`(`id`) ON UPDATE no action ON DELETE cascade
);
