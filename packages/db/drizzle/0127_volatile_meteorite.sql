CREATE TABLE `thread_submission_receipts` (
	`thread_id` text NOT NULL,
	`client_submission_id` text NOT NULL,
	`operation` text NOT NULL,
	`fingerprint` text NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `client_submission_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `client_submission_id` text;