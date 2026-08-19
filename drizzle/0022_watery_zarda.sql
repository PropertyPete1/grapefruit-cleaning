ALTER TABLE `email_log` ADD `alertSuppressed` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `email_log` ADD `alertSentAt` timestamp;