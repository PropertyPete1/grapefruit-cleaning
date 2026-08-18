-- Progressive booking links: the facts a phone lead may not know yet become
-- nullable, and adminProvided records which ones the owner locked at creation.
--
-- slotKey is a virtual column generated from scheduledDate/scheduledTime, and
-- MySQL refuses ALTERs on a column a generated column depends on. So the
-- column and its unique index come off first and go back on—with the IDENTICAL
-- expression—after the base columns change. CONCAT with a NULL argument is
-- NULL, so a slotless booking gets a NULL slotKey and the unique index ignores
-- it: no inventory held until a slot is actually claimed.
--
-- The index is absent for the few statements in between; the app's own
-- pre-insert availability check still guards that window, the same way it
-- guards the race the index exists to backstop.
ALTER TABLE `bookings` DROP INDEX `bookings_slotKey_unique`;--> statement-breakpoint
ALTER TABLE `bookings` DROP COLUMN `slotKey`;--> statement-breakpoint
ALTER TABLE `bookings` MODIFY COLUMN `serviceType` enum('residential','commercial','airbnb','moveinout','deep','office');--> statement-breakpoint
ALTER TABLE `bookings` MODIFY COLUMN `scheduledDate` varchar(10);--> statement-breakpoint
ALTER TABLE `bookings` MODIFY COLUMN `scheduledTime` varchar(5);--> statement-breakpoint
ALTER TABLE `bookings` MODIFY COLUMN `sqft` int;--> statement-breakpoint
ALTER TABLE `bookings` ADD `adminProvided` varchar(60);--> statement-breakpoint
ALTER TABLE `bookings` ADD `slotKey` varchar(16) GENERATED ALWAYS AS ((case when `status` in ('cancelled','expired') then null else concat(`scheduledDate`, 'T', `scheduledTime`) end)) VIRTUAL;--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_slotKey_unique` UNIQUE(`slotKey`);--> statement-breakpoint
ALTER TABLE `customers` MODIFY COLUMN `email` varchar(320);
