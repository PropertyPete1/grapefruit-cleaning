ALTER TABLE `payments` ADD `source` enum('stripe','offline') DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `receivedOn` varchar(10);--> statement-breakpoint
ALTER TABLE `payments` ADD `note` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `recordedByUserId` int;--> statement-breakpoint
ALTER TABLE `payments` ADD `recordedAt` timestamp;