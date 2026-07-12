ALTER TABLE "payments" ADD COLUMN "kind" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider_payment_id" text DEFAULT '' NOT NULL;