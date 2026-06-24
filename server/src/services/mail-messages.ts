import { and, desc, eq, gt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { mailMessages } from "@paperclipai/db";
import type { MailInboxQuery, MailMessage } from "@paperclipai/shared";
import { notFound } from "../errors.js";

export interface RecordInboundInput {
  addressId: string;
  agentId: string | null;
  fromAddr: string;
  toAddrs: string[];
  ccAddrs?: string[];
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  headers?: Record<string, string>;
  messageId?: string | null;
  inReplyTo?: string | null;
}

type MailMessageRow = typeof mailMessages.$inferSelect;

function toMailMessage(row: MailMessageRow): MailMessage {
  return {
    id: row.id,
    companyId: row.companyId,
    addressId: row.addressId,
    agentId: row.agentId,
    direction: row.direction as MailMessage["direction"],
    messageId: row.messageId,
    inReplyTo: row.inReplyTo,
    fromAddr: row.fromAddr,
    toAddrs: row.toAddrs ?? [],
    ccAddrs: row.ccAddrs ?? [],
    subject: row.subject,
    textBody: row.textBody,
    htmlBody: row.htmlBody,
    status: row.status as MailMessage["status"],
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

export function mailMessageService(db: Db) {
  return {
    /** Store a parsed inbound message (called by the SMTP listener). */
    recordInbound: async (companyId: string, input: RecordInboundInput): Promise<MailMessage> => {
      const row = await db
        .insert(mailMessages)
        .values({
          companyId,
          addressId: input.addressId,
          agentId: input.agentId,
          direction: "inbound",
          status: "received",
          fromAddr: input.fromAddr,
          toAddrs: input.toAddrs,
          ccAddrs: input.ccAddrs ?? [],
          subject: input.subject ?? null,
          textBody: input.textBody ?? null,
          htmlBody: input.htmlBody ?? null,
          headers: input.headers ?? {},
          messageId: input.messageId ?? null,
          inReplyTo: input.inReplyTo ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
      return toMailMessage(row);
    },

    listInbox: async (
      companyId: string,
      agentId: string,
      query: MailInboxQuery = {},
    ): Promise<MailMessage[]> => {
      const conditions = [
        eq(mailMessages.companyId, companyId),
        eq(mailMessages.agentId, agentId),
        eq(mailMessages.direction, "inbound"),
      ];
      if (query.status) conditions.push(eq(mailMessages.status, query.status));
      if (query.since) conditions.push(gt(mailMessages.createdAt, new Date(query.since)));
      const rows = await db
        .select()
        .from(mailMessages)
        .where(and(...conditions))
        .orderBy(desc(mailMessages.createdAt))
        .limit(query.limit ?? 50);
      return rows.map(toMailMessage);
    },

    getById: async (companyId: string, id: string): Promise<MailMessage> => {
      const row = await db
        .select()
        .from(mailMessages)
        .where(and(eq(mailMessages.id, id), eq(mailMessages.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Message not found");
      return toMailMessage(row);
    },

    markRead: async (companyId: string, id: string): Promise<MailMessage> => {
      const row = await db
        .update(mailMessages)
        .set({ status: "read", readAt: new Date(), updatedAt: new Date() })
        .where(and(eq(mailMessages.id, id), eq(mailMessages.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Message not found");
      return toMailMessage(row);
    },

    /**
     * Compact unread-inbox digest injected into an agent's run context, so the
     * agent notices and can act on new mail without polling.
     */
    buildRunEmailSummary: async (companyId: string, agentId: string): Promise<string> => {
      const rows = await db
        .select()
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.companyId, companyId),
            eq(mailMessages.agentId, agentId),
            eq(mailMessages.direction, "inbound"),
            eq(mailMessages.status, "received"),
          ),
        )
        .orderBy(desc(mailMessages.createdAt))
        .limit(10);
      if (rows.length === 0) return "";
      const lines = rows.map((r) => {
        const subject = (r.subject ?? "(no subject)").slice(0, 120);
        return `- from ${r.fromAddr} | ${subject} | id ${r.id}`;
      });
      return [
        `You have ${rows.length} unread email${rows.length === 1 ? "" : "s"}:`,
        ...lines,
        "Read full messages at GET $PAPERCLIP_API_URL/api/agents/$PAPERCLIP_AGENT_ID/email/inbox (Authorization: Bearer $PAPERCLIP_API_KEY).",
      ].join("\n");
    },
  };
}
