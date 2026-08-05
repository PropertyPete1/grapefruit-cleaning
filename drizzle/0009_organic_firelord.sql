ALTER TABLE `invoices` ADD `kind` enum('manual','balance') DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `payToken` varchar(64);--> statement-breakpoint
ALTER TABLE `invoices` ADD `stripeSessionId` varchar(255);--> statement-breakpoint
ALTER TABLE `invoices` ADD `stripePaymentIntentId` varchar(255);--> statement-breakpoint
ALTER TABLE `invoices` ADD `linkSentAt` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `linkExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `paidVia` enum('stripe','manual');--> statement-breakpoint
ALTER TABLE `invoices` ADD `refundNeeded` boolean DEFAULT false NOT NULL;