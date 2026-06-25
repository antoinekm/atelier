ALTER TABLE "mail_message_attachments" ADD COLUMN IF NOT EXISTS "agent_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_message_attachments" ADD CONSTRAINT "mail_message_attachments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_message_attachments_agent_idx" ON "mail_message_attachments" USING btree ("agent_id");--> statement-breakpoint
UPDATE "mail_message_attachments" a SET "agent_id" = m."agent_id" FROM "mail_messages" m WHERE a."mail_message_id" = m."id" AND a."agent_id" IS NULL;
