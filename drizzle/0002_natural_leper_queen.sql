ALTER TABLE `users` MODIFY COLUMN `role` enum('user','staff','admin') NOT NULL DEFAULT 'user';--> statement-breakpoint
ALTER TABLE `employees` ADD `userId` int;