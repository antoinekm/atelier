CREATE TABLE IF NOT EXISTS "mail_sender_blocks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "value" text NOT NULL,
  "reason" text,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_sender_blocks" ADD CONSTRAINT "mail_sender_blocks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_sender_blocks" ADD CONSTRAINT "mail_sender_blocks_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_sender_blocks_company_kind_value_uq" ON "mail_sender_blocks" USING btree ("company_id","kind","value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_sender_blocks_company_idx" ON "mail_sender_blocks" USING btree ("company_id");
