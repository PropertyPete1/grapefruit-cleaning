ALTER TABLE `customers` ADD `marketingUnsubscribedAt` timestamp;--> statement-breakpoint
ALTER TABLE `customers` ADD `marketingToken` varchar(64);--> statement-breakpoint
ALTER TABLE `customers` ADD `lastMarketingEmailAt` timestamp;--> statement-breakpoint
ALTER TABLE `customers` ADD `marketingEmailCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `customers` ADD CONSTRAINT `customers_marketingToken_unique` UNIQUE(`marketingToken`);