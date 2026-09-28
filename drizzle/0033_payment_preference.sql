ALTER TABLE `bookings` ADD `paymentPreference` enum('online','cash');--> statement-breakpoint
ALTER TABLE `bookings` ADD `cashChosenAt` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `serviceType` varchar(20);--> statement-breakpoint
ALTER TABLE `invoices` ADD `serviceDate` varchar(10);--> statement-breakpoint
ALTER TABLE `invoices` ADD `paymentPreference` enum('online','cash');--> statement-breakpoint
ALTER TABLE `invoices` ADD `cashChosenAt` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `paidMethod` varchar(40);