ALTER TABLE "cloudflare_connections" ADD COLUMN IF NOT EXISTS "auth_type" text DEFAULT 'token' NOT NULL;--> statement-breakpoint
ALTER TABLE "cloudflare_connections" ADD COLUMN IF NOT EXISTS "refresh_token_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "cloudflare_connections" ADD COLUMN IF NOT EXISTS "access_token_expires_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloudflare_connections" ADD CONSTRAINT "cloudflare_connections_refresh_token_secret_id_company_secrets_id_fk" FOREIGN KEY ("refresh_token_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
