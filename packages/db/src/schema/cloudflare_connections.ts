import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { companySecrets } from "./company_secrets.js";

/**
 * A company's connection to a Cloudflare account (embedded mail, phase 0).
 *
 * The platform uses the connected account's API token to read the account's
 * zones and to publish mail DNS records (MX/SPF/DKIM/DMARC) on the domains the
 * human chooses to attach. The raw token is never stored here: it lives in
 * `company_secrets` and only its id is referenced (`apiTokenSecretId`), the same
 * secret_ref pattern used by MCP servers and credentials.
 *
 * V1 supports a single Cloudflare connection per company (unique on companyId).
 */
export const cloudflareConnections = pgTable(
  "cloudflare_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    cfAccountId: text("cf_account_id"),
    // How the account was connected: a pasted API token, or the OAuth flow.
    authType: text("auth_type").notNull().default("token"),
    // For OAuth this holds the access token; for token auth it holds the API token.
    apiTokenSecretId: uuid("api_token_secret_id")
      .notNull()
      .references(() => companySecrets.id, { onDelete: "cascade" }),
    // OAuth-only: the refresh token (to mint new access tokens) and the access
    // token's expiry so we can refresh proactively.
    refreshTokenSecretId: uuid("refresh_token_secret_id").references(() => companySecrets.id, {
      onDelete: "set null",
    }),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("cloudflare_connections_company_uq").on(table.companyId),
  }),
);
