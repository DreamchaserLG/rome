ALTER TABLE `channels` ADD `agent` text;--> statement-breakpoint
CREATE UNIQUE INDEX `channels_platform_agent_unique` ON `channels` (`platform`,`agent`) WHERE "channels"."agent" IS NOT NULL;