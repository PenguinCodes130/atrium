CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_user_id` text,
	`actor_token_id` text,
	`actor_agent_name` text,
	`actor_guest_link_id` text,
	`actor_guest_label` text,
	`actor_ip` text,
	`event` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`target_label` text,
	`proposal_id` text,
	`result` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_event_idx` ON `audit_log` (`event`);--> statement-breakpoint
CREATE INDEX `audit_log_target_idx` ON `audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor_user_id`);