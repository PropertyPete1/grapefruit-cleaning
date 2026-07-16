ALTER TABLE `bookings` ADD `verifiedSqft` int;--> statement-breakpoint
ALTER TABLE `bookings` ADD `sqftSource` varchar(30);--> statement-breakpoint
ALTER TABLE `bookings` ADD `sqftMismatch` boolean DEFAULT false NOT NULL;