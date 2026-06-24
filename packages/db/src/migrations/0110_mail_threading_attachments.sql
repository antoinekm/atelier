ALTER TABLE "mail_messages" ADD COLUMN IF NOT EXISTS "references" text;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN IF NOT EXISTS "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN IF NOT EXISTS "bcc_addrs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN IF NOT EXISTS "is_starred" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN IF NOT EXISTS "is_archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_message_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "mail_message_id" uuid,
  "direction" text NOT NULL,
  "provider" text NOT NULL,
  "object_key" text NOT NULL,
  "content_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "sha256" text NOT NULL,
  "original_filename" text,
  "content_id" text,
  "inline" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_message_attachments" ADD CONSTRAINT "mail_message_attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_message_attachments" ADD CONSTRAINT "mail_message_attachments_mail_message_id_mail_messages_id_fk" FOREIGN KEY ("mail_message_id") REFERENCES "public"."mail_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_messages_thread_idx" ON "mail_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_messages_company_agent_folder_idx" ON "mail_messages" USING btree ("company_id","agent_id","direction","is_archived","deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_messages_message_id_idx" ON "mail_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_message_attachments_message_idx" ON "mail_message_attachments" USING btree ("mail_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_message_attachments_company_idx" ON "mail_message_attachments" USING btree ("company_id");--> statement-breakpoint
UPDATE "mail_messages" SET "thread_id" = "id" WHERE "thread_id" IS NULL AND "in_reply_to" IS NULL AND "references" IS NULL;--> statement-breakpoint
UPDATE "mail_messages" c SET "thread_id" = p."thread_id" FROM "mail_messages" p WHERE c."thread_id" IS NULL AND p."thread_id" IS NOT NULL AND p."message_id" IS NOT NULL AND c."in_reply_to" = p."message_id" AND c."company_id" = p."company_id";--> statement-breakpoint
UPDATE "mail_messages" c SET "thread_id" = p."thread_id" FROM "mail_messages" p WHERE c."thread_id" IS NULL AND p."thread_id" IS NOT NULL AND p."message_id" IS NOT NULL AND c."in_reply_to" = p."message_id" AND c."company_id" = p."company_id";--> statement-breakpoint
UPDATE "mail_messages" c SET "thread_id" = p."thread_id" FROM "mail_messages" p WHERE c."thread_id" IS NULL AND p."thread_id" IS NOT NULL AND p."message_id" IS NOT NULL AND c."in_reply_to" = p."message_id" AND c."company_id" = p."company_id";--> statement-breakpoint
UPDATE "mail_messages" c SET "thread_id" = p."thread_id" FROM "mail_messages" p WHERE c."thread_id" IS NULL AND p."thread_id" IS NOT NULL AND p."message_id" IS NOT NULL AND c."in_reply_to" = p."message_id" AND c."company_id" = p."company_id";--> statement-breakpoint
UPDATE "mail_messages" c SET "thread_id" = p."thread_id" FROM "mail_messages" p WHERE c."thread_id" IS NULL AND p."thread_id" IS NOT NULL AND p."message_id" IS NOT NULL AND c."in_reply_to" = p."message_id" AND c."company_id" = p."company_id";--> statement-breakpoint
UPDATE "mail_messages" c SET "thread_id" = p."thread_id" FROM "mail_messages" p WHERE c."thread_id" IS NULL AND p."thread_id" IS NOT NULL AND p."message_id" IS NOT NULL AND c."in_reply_to" = p."message_id" AND c."company_id" = p."company_id";--> statement-breakpoint
UPDATE "mail_messages" SET "thread_id" = "id" WHERE "thread_id" IS NULL;
