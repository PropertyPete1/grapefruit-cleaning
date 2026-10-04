CREATE TABLE `invoice_checkout_sessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoiceId` int NOT NULL,
	`stripeSessionId` varchar(255) NOT NULL,
	`attempt` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`expiresAt` timestamp NOT NULL,
	`endedAt` timestamp,
	`endReason` varchar(40),
	CONSTRAINT `invoice_checkout_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoice_checkout_sessions_session_unique` UNIQUE(`stripeSessionId`)
);
--> statement-breakpoint
ALTER TABLE `invoices` ADD `stripeSessionExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `checkoutAttempt` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `checkoutClaimedAt` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `paymentProcessingAt` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `paymentProcessingIntentId` varchar(255);--> statement-breakpoint
ALTER TABLE `invoices` ADD `lastDuplicateIntentId` varchar(255);--> statement-breakpoint
ALTER TABLE `payments` ADD `duplicate` boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `invoice_checkout_sessions_invoice_idx` ON `invoice_checkout_sessions` (`invoiceId`,`createdAt`);