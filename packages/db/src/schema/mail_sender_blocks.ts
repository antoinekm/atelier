import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * A blocked sender for a company's embedded mail. An entry blocks either a single
 * address (`kind = 'address'`, e.g. `spammer@x.com`) or a whole domain
 * (`kind = 'domain'`, e.g. `x.com`, matching the domain and its subdomains), so a
 * spammer cannot just rotate local-parts on the same domain. Enforced at SMTP
 * reception; manageable by the company's agents and board.
 */
export const mailSenderBlocks = pgTable(
  "mail_sender_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    reason: text("reason"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKindValueUq: uniqueIndex("mail_sender_blocks_company_kind_value_uq").on(
      table.companyId,
      table.kind,
      table.value,
    ),
    companyIdx: index("mail_sender_blocks_company_idx").on(table.companyId),
  }),
);
