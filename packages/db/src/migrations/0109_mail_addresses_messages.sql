CREATE TABLE IF NOT EXISTS "mail_addresses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "domain_id" uuid NOT NULL,
  "agent_id" uuid,
  "local_part" text NOT NULL,
  "address" text NOT NULL,
  "kind" text DEFAULT 'mailbox' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "address_id" uuid NOT NULL,
  "agent_id" uuid,
  "direction" text DEFAULT 'inbound' NOT NULL,
  "message_id" text,
  "in_reply_to" text,
  "from_addr" text NOT NULL,
  "to_addrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cc_addrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "subject" text,
  "text_body" text,
  "html_body" text,
  "headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'received' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "error" text,
  "sent_at" timestamp with time zone,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_addresses" ADD CONSTRAINT "mail_addresses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_addresses" ADD CONSTRAINT "mail_addresses_domain_id_mail_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."mail_domains"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_addresses" ADD CONSTRAINT "mail_addresses_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_addresses" ADD CONSTRAINT "mail_addresses_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_address_id_mail_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."mail_addresses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_addresses_domain_local_part_uq" ON "mail_addresses" USING btree ("domain_id","local_part");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_addresses_address_uq" ON "mail_addresses" USING btree ("address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_addresses_company_agent_idx" ON "mail_addresses" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_messages_company_agent_dir_status_idx" ON "mail_messages" USING btree ("company_id","agent_id","direction","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_messages_address_created_idx" ON "mail_messages" USING btree ("address_id","created_at");
