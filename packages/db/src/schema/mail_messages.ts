import { pgTable, uuid, text, jsonb, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { mailAddresses } from "./mail_addresses.js";

/**
 * A stored email message (embedded mail, phase 1 = inbound; phase 2 adds
 * outbound). Inbound mail is written by the SMTP listener after MIME parsing and
 * surfaced to the owning agent via the inbox API + run context.
 *
 * `direction`: `inbound` | `outbound`.
 * `status`: inbound -> `received` | `read`; outbound -> `queued` | `sending` |
 * `sent` | `failed` | `bounced`.
 */
export const mailMessages = pgTable(
  "mail_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    addressId: uuid("address_id").notNull().references(() => mailAddresses.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    direction: text("direction").notNull().default("inbound"),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    fromAddr: text("from_addr").notNull(),
    toAddrs: jsonb("to_addrs").$type<string[]>().notNull().default([]),
    ccAddrs: jsonb("cc_addrs").$type<string[]>().notNull().default([]),
    subject: text("subject"),
    textBody: text("text_body"),
    htmlBody: text("html_body"),
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    status: text("status").notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentDirStatusIdx: index("mail_messages_company_agent_dir_status_idx").on(
      table.companyId,
      table.agentId,
      table.direction,
      table.status,
    ),
    addressCreatedIdx: index("mail_messages_address_created_idx").on(table.addressId, table.createdAt),
  }),
);
