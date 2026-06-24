import { pgTable, uuid, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { mailMessages } from "./mail_messages.js";

/**
 * A binary attachment on a mail message (embedded mail). The bytes live in the
 * storage service (local disk or S3, same as assets); this row only tracks the
 * object key + metadata. Inbound attachments are stored by the SMTP listener;
 * outbound attachments are staged on upload (before the message is composed) and
 * then linked to the message on send.
 *
 * `inline` + `contentId` mark inline/cid parts (e.g. embedded images) so the
 * reader can render them and the outbound worker can re-embed them.
 */
export const mailMessageAttachments = pgTable(
  "mail_message_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    mailMessageId: uuid("mail_message_id").references(() => mailMessages.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    provider: text("provider").notNull(),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    originalFilename: text("original_filename"),
    contentId: text("content_id"),
    inline: boolean("inline").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    messageIdx: index("mail_message_attachments_message_idx").on(table.mailMessageId),
    companyIdx: index("mail_message_attachments_company_idx").on(table.companyId),
  }),
);
