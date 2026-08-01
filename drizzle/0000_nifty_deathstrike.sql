CREATE TABLE `appointment_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`patient_key` text NOT NULL,
	`patient_initials` text NOT NULL,
	`encrypted_contact` text,
	`specialty` text NOT NULL,
	`provider_id` text,
	`provider_name` text,
	`facility_name` text,
	`provider_phone` text,
	`provider_website` text,
	`address` text,
	`location` text NOT NULL,
	`modality` text NOT NULL,
	`requested_date` text NOT NULL,
	`time_window` text NOT NULL,
	`timezone` text NOT NULL,
	`reason_category` text NOT NULL,
	`status` text DEFAULT 'pending_provider' NOT NULL,
	`source` text DEFAULT 'web' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `appointment_patient_idx` ON `appointment_requests` (`patient_key`);--> statement-breakpoint
CREATE INDEX `appointment_created_idx` ON `appointment_requests` (`created_at`);--> statement-breakpoint
CREATE TABLE `consent_events` (
	`id` text PRIMARY KEY NOT NULL,
	`patient_key` text NOT NULL,
	`appointment_id` text,
	`care_data_granted` integer NOT NULL,
	`screening_granted` integer NOT NULL,
	`sms_granted` integer NOT NULL,
	`policy_version` text NOT NULL,
	`channel` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `consent_patient_idx` ON `consent_events` (`patient_key`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`appointment_id` text NOT NULL,
	`channel` text NOT NULL,
	`provider_message_id` text,
	`status` text NOT NULL,
	`error_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_appointment_idx` ON `notifications` (`appointment_id`);--> statement-breakpoint
CREATE INDEX `notification_provider_id_idx` ON `notifications` (`provider_message_id`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`window_started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhook_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_external_idx` ON `webhook_receipts` (`provider`,`external_id`);