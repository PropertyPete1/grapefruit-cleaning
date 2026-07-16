ALTER TABLE `employees` ADD `inviteToken` varchar(64);--> statement-breakpoint
ALTER TABLE `employees` ADD `inviteSentAt` timestamp;--> statement-breakpoint
ALTER TABLE `employees` ADD `inviteAcceptedAt` timestamp;