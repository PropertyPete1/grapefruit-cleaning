ALTER TABLE `bookings` ADD `kind` enum('self_serve','admin') DEFAULT 'self_serve' NOT NULL;--> statement-breakpoint
ALTER TABLE `bookings` ADD `holdMinutes` int;--> statement-breakpoint
ALTER TABLE `bookings` ADD `payToken` varchar(64);--> statement-breakpoint
ALTER TABLE `bookings` ADD `payTokenExpiresAt` timestamp;