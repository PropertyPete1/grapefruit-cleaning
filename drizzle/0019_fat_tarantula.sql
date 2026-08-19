ALTER TABLE `invoices` ADD `reminderCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `lastReminderAt` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `reminderExhaustedAlertAt` timestamp;