ALTER TABLE `bookings` ADD `grandfatheredBaseCents` int;--> statement-breakpoint
ALTER TABLE `bookings` ADD `grandfatheredCustomerId` int;--> statement-breakpoint
ALTER TABLE `customers` ADD `grandfatheredPriceCents` int;--> statement-breakpoint
ALTER TABLE `customers` ADD `grandfatheredServiceType` enum('residential','commercial','airbnb','moveinout','deep','office');--> statement-breakpoint
ALTER TABLE `customers` ADD `grandfatheredNote` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `grandfatheredAt` timestamp;--> statement-breakpoint
ALTER TABLE `customers` ADD `grandfatheredByUserId` int;