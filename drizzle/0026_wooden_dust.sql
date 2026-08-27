ALTER TABLE `bookings` ADD `baseAmountCents` int;--> statement-breakpoint
ALTER TABLE `bookings` ADD `addonsAmountCents` int;--> statement-breakpoint
ALTER TABLE `bookings` ADD `totalAmountCents` int;--> statement-breakpoint
ALTER TABLE `bookings` ADD `depositAmountCents` int;--> statement-breakpoint
ALTER TABLE `bookings` ADD `discountAppliedCents` int;--> statement-breakpoint
ALTER TABLE `invoices` ADD `amountCents` int;--> statement-breakpoint
ALTER TABLE `invoices` ADD `computedAmountCents` int;--> statement-breakpoint
ALTER TABLE `payments` ADD `amountCents` int;