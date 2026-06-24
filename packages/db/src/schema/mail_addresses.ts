import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { mailDomains } from "./mail_domains.js";

/**
 * An email address on an attached mail domain (embedded mail, phase 1).
 *
 * Addresses belong to a company and may be owned by an agent (`agentId`) or be
 * company-shared (`agentId` null, e.g. a catch-all). An agent can own MANY
 * addresses (several rows with the same `agentId`), which is how agents get
 * "as many addresses as they need".
 *
 * `kind`:
 * - `mailbox`:   a normal addressable inbox (local@domain)
 * - `alias`:     forwards/aliases to a mailbox (reserved for later)
 * - `catch_all`: receives any unmatched local-part for the domain (localPart `*`)
 */
export const mailAddresses = pgTable(
  "mail_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    domainId: uuid("domain_id").notNull().references(() => mailDomains.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    localPart: text("local_part").notNull(),
    address: text("address").notNull(),
    kind: text("kind").notNull().default("mailbox"),
    status: text("status").notNull().default("active"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    domainLocalPartUq: uniqueIndex("mail_addresses_domain_local_part_uq").on(table.domainId, table.localPart),
    addressUq: uniqueIndex("mail_addresses_address_uq").on(table.address),
    companyAgentIdx: index("mail_addresses_company_agent_idx").on(table.companyId, table.agentId),
  }),
);
