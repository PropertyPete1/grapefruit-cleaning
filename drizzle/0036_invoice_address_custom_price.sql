ALTER TABLE `bookings` ADD `customPriceCents` int;--> statement-breakpoint
ALTER TABLE `bookings` ADD `customPriceReason` varchar(500);--> statement-breakpoint
ALTER TABLE `bookings` ADD `customPriceByUserId` int;--> statement-breakpoint
ALTER TABLE `bookings` ADD `customPriceAt` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `serviceAddress` varchar(255);--> statement-breakpoint
ALTER TABLE `invoices` ADD `serviceCity` varchar(100);--> statement-breakpoint
ALTER TABLE `invoices` ADD `serviceZip` varchar(20);