CREATE TABLE `blog_posts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`slug` varchar(160) NOT NULL,
	`titleEn` varchar(255) NOT NULL,
	`titleEs` varchar(255) NOT NULL,
	`excerptEn` text,
	`excerptEs` text,
	`bodyEn` text NOT NULL,
	`bodyEs` text NOT NULL,
	`coverImage` varchar(500),
	`readTime` int NOT NULL DEFAULT 5,
	`published` boolean NOT NULL DEFAULT false,
	`publishedAt` varchar(10),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `blog_posts_id` PRIMARY KEY(`id`),
	CONSTRAINT `blog_posts_slug_unique` UNIQUE(`slug`)
);
