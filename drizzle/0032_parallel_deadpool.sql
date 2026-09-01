CREATE TABLE `booking_reschedule_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`bookingId` int NOT NULL,
	`status` enum('pending','countered','approved','declined','withdrawn') NOT NULL DEFAULT 'pending',
	`proposedDate` varchar(10) NOT NULL,
	`proposedTime` varchar(5) NOT NULL,
	`customerNote` text,
	`counterDate` varchar(10),
	`counterTime` varchar(5),
	`adminNote` text,
	`locale` enum('en','es') NOT NULL DEFAULT 'en',
	`resolvedByUserId` int,
	`resolvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `booking_reschedule_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `booking_schedule_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`bookingId` int NOT NULL,
	`requestId` int,
	`actorType` enum('admin','customer','staff','ical','brain','system') NOT NULL,
	`actorUserId` int,
	`actorLabel` varchar(200),
	`action` varchar(40) NOT NULL,
	`fromDate` varchar(10),
	`fromTime` varchar(5),
	`toDate` varchar(10),
	`toTime` varchar(5),
	`note` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `booking_schedule_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `bookings` ADD `rescheduleTokenHash` varchar(64);--> statement-breakpoint
ALTER TABLE `bookings` ADD `rescheduleTokenExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `bookings` ADD `icalSourceDate` varchar(10);--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_rescheduleTokenHash_unique` UNIQUE(`rescheduleTokenHash`);--> statement-breakpoint
CREATE INDEX `booking_reschedule_requests_booking_idx` ON `booking_reschedule_requests` (`bookingId`);--> statement-breakpoint
CREATE INDEX `booking_reschedule_requests_status_created_idx` ON `booking_reschedule_requests` (`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `booking_schedule_events_booking_created_idx` ON `booking_schedule_events` (`bookingId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `booking_schedule_events_request_idx` ON `booking_schedule_events` (`requestId`);