import { pgTable, uuid, text, jsonb, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { mailAddresses } from "./mail_addresses.js";

/**
 * A stored email message (embedded mail). Inbound mail is written by the SMTP
 * listener after MIME parsing; outbound mail is enqueued by the send API and
 * delivered by the outbound worker. Both directions are surfaced to the owning
 * agent via the mailbox API + run context.
 *
 * `direction`: `inbound` | `outbound`.
 * `status`: inbound -> `received` | `read`; outbound -> `draft` | `queued` |
 * `sending` | `sent` | `failed` | `bounced`.
 *
 * `threadId` groups a conversation (resolved from In-Reply-To/References, with a
 * conservative subject fallback). `isStarred` / `isArchived` / `deletedAt` are the
 * Gmail-like folder flags (Trash is a soft delete via `deletedAt`).
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
    references: text("references"),
    threadId: uuid("thread_id"),
    fromAddr: text("from_addr").notNull(),
    toAddrs: jsonb("to_addrs").$type<string[]>().notNull().default([]),
    ccAddrs: jsonb("cc_addrs").$type<string[]>().notNull().default([]),
    bccAddrs: jsonb("bcc_addrs").$type<string[]>().notNull().default([]),
    subject: text("subject"),
    textBody: text("text_body"),
    htmlBody: text("html_body"),
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    status: text("status").notNull().default("received"),
    isStarred: boolean("is_starred").notNull().default(false),
    isArchived: boolean("is_archived").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
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
    threadIdx: index("mail_messages_thread_idx").on(table.threadId, table.createdAt),
    companyAgentFolderIdx: index("mail_messages_company_agent_folder_idx").on(
      table.companyId,
      table.agentId,
      table.direction,
      table.isArchived,
      table.deletedAt,
    ),
    messageIdIdx: index("mail_messages_message_id_idx").on(table.messageId),
  }),
);
