ALTER TABLE `bookings` ADD `unitNumber` varchar(20);--> statement-breakpoint
ALTER TABLE `bookings` ADD `propertyType` enum('house','apartment') DEFAULT 'house' NOT NULL;