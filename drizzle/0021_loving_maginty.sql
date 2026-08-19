CREATE TABLE `email_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`recipient` varchar(320),
	`subject` varchar(500) NOT NULL,
	`emailType` varchar(60) NOT NULL DEFAULT 'other',
	`outcome` enum('delivered','log_only','error','skipped') NOT NULL,
	`errorText` varchar(500),
	`smtpUser` varchar(320),
	`invoiceId` int,
	`bookingId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_log_id` PRIMARY KEY(`id`)
);
