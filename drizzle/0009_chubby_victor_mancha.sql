CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"contact_key" text NOT NULL,
	"rate_kopecks" integer DEFAULT 0 NOT NULL,
	"meet_link" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_contact_key_unique" UNIQUE("contact_key")
);
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;