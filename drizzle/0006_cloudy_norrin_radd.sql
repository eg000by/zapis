ALTER TABLE "students" ADD COLUMN "trial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "trial_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "meet_link" text DEFAULT '' NOT NULL;