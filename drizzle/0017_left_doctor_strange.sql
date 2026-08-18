CREATE TABLE `connected_properties` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customerId` int NOT NULL,
	`label` varchar(120) NOT NULL,
	`addressLine` varchar(255) NOT NULL,
	`unitNumber` varchar(20),
	`propertyType` enum('house','apartment') NOT NULL DEFAULT 'apartment',
	`city` varchar(100),
	`zip` varchar(20),
	`sqft` int NOT NULL,
	`serviceType` enum('residential','commercial','airbnb','moveinout','deep','office') NOT NULL DEFAULT 'airbnb',
	`icalUrl` varchar(500) NOT NULL,
	`defaultTime` varchar(5) NOT NULL DEFAULT '11:00',
	`active` boolean NOT NULL DEFAULT true,
	`autoBook` boolean NOT NULL DEFAULT true,
	`perCleanEmails` boolean NOT NULL DEFAULT false,
	`lastSyncAt` timestamp,
	`lastSyncStatus` varchar(500),
	`reservationCount` int,
	`consecutiveFailures` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `connected_properties_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `bookings` MODIFY COLUMN `kind` enum('self_serve','admin','ical_auto') NOT NULL DEFAULT 'self_serve';--> statement-breakpoint
ALTER TABLE `bookings` ADD `propertyId` int;--> statement-breakpoint
ALTER TABLE `bookings` ADD `icalUid` varchar(255);--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_property_uid_unique` UNIQUE(`propertyId`,`icalUid`);