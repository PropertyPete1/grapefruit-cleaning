ALTER TABLE `invoices` MODIFY COLUMN `status` enum('draft','sent','paid','overdue','void','awaiting_approval') NOT NULL DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE `invoices` ADD `computedAmount` int;--> statement-breakpoint
ALTER TABLE `invoices` ADD `approvedAt` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `approvedByUserId` int;