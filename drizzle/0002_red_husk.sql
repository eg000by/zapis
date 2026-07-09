CREATE TABLE "bot_state" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"target_id" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
