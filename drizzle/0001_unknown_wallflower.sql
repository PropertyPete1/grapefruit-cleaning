CREATE TABLE `bookings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`reference` varchar(20) NOT NULL,
	`customerId` int NOT NULL,
	`serviceType` enum('residential','commercial','airbnb','moveinout','deep','office') NOT NULL,
	`frequency` enum('onetime','weekly','biweekly','monthly') NOT NULL DEFAULT 'onetime',
	`scheduledDate` varchar(10) NOT NULL,
	`scheduledTime` varchar(5) NOT NULL,
	`bedrooms` int NOT NULL DEFAULT 2,
	`bathrooms` int NOT NULL DEFAULT 1,
	`sqft` int NOT NULL DEFAULT 1000,
	`extras` text,
	`addressLine` varchar(255),
	`city` varchar(100),
	`zip` varchar(20),
	`notes` text,
	`locale` enum('en','es') NOT NULL DEFAULT 'en',
	`totalAmount` int NOT NULL,
	`depositAmount` int NOT NULL,
	`status` enum('pending_deposit','confirmed','in_progress','completed','cancelled') NOT NULL DEFAULT 'pending_deposit',
	`employeeId` int,
	`couponCode` varchar(40),
	`discountApplied` int NOT NULL DEFAULT 0,
	`stripeSessionId` varchar(255),
	`stripePaymentIntentId` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bookings_id` PRIMARY KEY(`id`),
	CONSTRAINT `bookings_reference_unique` UNIQUE(`reference`)
);
--> statement-breakpoint
CREATE TABLE `contact_messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(200) NOT NULL,
	`email` varchar(320) NOT NULL,
	`phone` varchar(40),
	`subject` varchar(255),
	`message` text NOT NULL,
	`locale` enum('en','es') NOT NULL DEFAULT 'en',
	`status` enum('new','replied','archived') NOT NULL DEFAULT 'new',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contact_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `coupons` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(40) NOT NULL,
	`description` varchar(255),
	`percentOff` int,
	`amountOff` int,
	`active` boolean NOT NULL DEFAULT true,
	`maxRedemptions` int,
	`timesRedeemed` int NOT NULL DEFAULT 0,
	`expiresAt` varchar(10),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `coupons_id` PRIMARY KEY(`id`),
	CONSTRAINT `coupons_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`firstName` varchar(100) NOT NULL,
	`lastName` varchar(100) NOT NULL,
	`email` varchar(320) NOT NULL,
	`phone` varchar(40),
	`address` varchar(255),
	`city` varchar(100),
	`zip` varchar(20),
	`preferredLocale` enum('en','es') NOT NULL DEFAULT 'en',
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `customers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `employees` (
	`id` int AUTO_INCREMENT NOT NULL,
	`firstName` varchar(100) NOT NULL,
	`lastName` varchar(100) NOT NULL,
	`email` varchar(320),
	`phone` varchar(40),
	`role` varchar(100) DEFAULT 'Cleaner',
	`active` boolean NOT NULL DEFAULT true,
	`hiredAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `employees_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `gallery_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`url` varchar(500) NOT NULL,
	`fileKey` varchar(255),
	`altEn` varchar(255),
	`altEs` varchar(255),
	`category` enum('residential','commercial','airbnb','deep') NOT NULL DEFAULT 'residential',
	`sortOrder` int NOT NULL DEFAULT 0,
	`visible` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `gallery_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`number` varchar(20) NOT NULL,
	`bookingId` int,
	`customerId` int NOT NULL,
	`amount` int NOT NULL,
	`status` enum('draft','sent','paid','overdue','void') NOT NULL DEFAULT 'draft',
	`dueDate` varchar(10),
	`paidAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoices_number_unique` UNIQUE(`number`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`bookingId` int,
	`invoiceId` int,
	`customerId` int,
	`amount` int NOT NULL,
	`kind` enum('deposit','balance','full','refund') NOT NULL DEFAULT 'deposit',
	`method` varchar(40) DEFAULT 'card',
	`stripePaymentIntentId` varchar(255),
	`status` enum('pending','succeeded','failed','refunded') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customerName` varchar(200) NOT NULL,
	`bookingId` int,
	`rating` int NOT NULL,
	`text` text,
	`source` varchar(60) DEFAULT 'website',
	`approved` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `reviews_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `site_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`settingKey` varchar(100) NOT NULL,
	`settingValue` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_settings_settingKey_unique` UNIQUE(`settingKey`)
);
