ALTER TABLE `payments` MODIFY COLUMN `kind` enum('deposit','balance','full','refund','tip') NOT NULL DEFAULT 'deposit';--> statement-breakpoint
ALTER TABLE `bookings` ADD `tipToken` varchar(64);--> statement-breakpoint
ALTER TABLE `bookings` ADD `tipEmailSentAt` timestamp;--> statement-breakpoint
ALTER TABLE `bookings` ADD `tipPaidAt` timestamp;--> statement-breakpoint
ALTER TABLE `bookings` ADD `tipAmount` int;--> statement-breakpoint
ALTER TABLE `bookings` ADD `tipStripePaymentIntentId` varchar(255);--> statement-breakpoint
ALTER TABLE `bookings` ADD `tipDeclinedAt` timestamp;