import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { mailMessages, mailMessageAttachments } from "@paperclipai/db";
import type {
  MailAttachment,
  MailFolder,
  MailFolderCounts,
  MailInboxQuery,
  MailListPage,
  MailListQuery,
  MailMessage,
  MailMessageListItem,
  MailThread,
  MailThreadSummary,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

const MAX_SEND_ATTEMPTS = 5;
const SUBJECT_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface EnqueueOutboundInput {
  addressId: string;
  agentId: string;
  fromAddr: string;
  toAddrs: string[];
  ccAddrs?: string[];
  bccAddrs?: string[];
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  attachmentIds?: string[];
}

export interface RecordInboundInput {
  addressId: string;
  agentId: string | null;
  fromAddr: string;
  toAddrs: string[];
  ccAddrs?: string[];
  bccAddrs?: string[];
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  headers?: Record<string, string>;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}

export interface SaveDraftInput {
  addressId: string;
  fromAddr: string;
  toAddrs?: string[];
  ccAddrs?: string[];
  bccAddrs?: string[];
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}

export interface InboundAttachmentInput {
  direction: "inbound" | "outbound";
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  contentId?: string | null;
  inline?: boolean;
}

type MailMessageRow = typeof mailMessages.$inferSelect;
type MailAttachmentRow = typeof mailMessageAttachments.$inferSelect;

function toMailAttachment(row: MailAttachmentRow): MailAttachment {
  return {
    id: row.id,
    mailMessageId: row.mailMessageId,
    direction: row.direction as MailAttachment["direction"],
    contentType: row.contentType,
    byteSize: row.byteSize,
    originalFilename: row.originalFilename,
    contentId: row.contentId,
    inline: row.inline,
    createdAt: row.createdAt,
  };
}

function toMailMessage(row: MailMessageRow, attachments: MailAttachmentRow[] = []): MailMessage {
  return {
    id: row.id,
    companyId: row.companyId,
    addressId: row.addressId,
    agentId: row.agentId,
    direction: row.direction as MailMessage["direction"],
    messageId: row.messageId,
    inReplyTo: row.inReplyTo,
    references: row.references,
    threadId: row.threadId,
    fromAddr: row.fromAddr,
    toAddrs: row.toAddrs ?? [],
    ccAddrs: row.ccAddrs ?? [],
    bccAddrs: row.bccAddrs ?? [],
    subject: row.subject,
    textBody: row.textBody,
    htmlBody: row.htmlBody,
    status: row.status as MailMessage["status"],
    isStarred: row.isStarred,
    isArchived: row.isArchived,
    deletedAt: row.deletedAt,
    error: row.error,
    attempts: row.attempts,
    sentAt: row.sentAt,
    readAt: row.readAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    attachments: attachments.map(toMailAttachment),
  };
}

/** A short preview line for list rows: first non-empty text, html stripped. */
function snippetOf(row: Pick<MailMessageRow, "textBody" | "htmlBody">): string {
  const raw = row.textBody ?? (row.htmlBody ? row.htmlBody.replace(/<[^>]*>/g, " ") : "");
  return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

function toMailListItem(row: MailMessageRow, hasAttachments: boolean): MailMessageListItem {
  return {
    id: row.id,
    threadId: row.threadId,
    direction: row.direction as MailMessageListItem["direction"],
    fromAddr: row.fromAddr,
    toAddrs: row.toAddrs ?? [],
    subject: row.subject,
    snippet: snippetOf(row),
    status: row.status as MailMessageListItem["status"],
    isStarred: row.isStarred,
    isArchived: row.isArchived,
    hasAttachments,
    error: row.error,
    createdAt: row.createdAt,
  };
}

/** Strip leading Re:/Fwd: and collapse whitespace for subject-based threading. */
function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? "")
    .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** RFC message-ids from a References header (space/newline separated). */
function parseReferences(references: string | null | undefined): string[] {
  if (!references) return [];
  return references.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const createdAt = new Date(iso);
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function mailMessageService(db: Db) {
  /**
   * Resolve the conversation a message belongs to. Prefers reliable RFC headers
   * (In-Reply-To, then the References chain), then a conservative subject match
   * (same mailbox, recent, shared participant), else a fresh thread id.
   */
  async function resolveThreadId(
    companyId: string,
    input: {
      agentId: string | null;
      inReplyTo?: string | null;
      references?: string | null;
      subject?: string | null;
      participants: string[];
    },
  ): Promise<string> {
    const candidates = [
      ...(input.inReplyTo ? [input.inReplyTo] : []),
      ...parseReferences(input.references).reverse(),
    ];
    for (const mid of candidates) {
      const parent = await db
        .select({ threadId: mailMessages.threadId })
        .from(mailMessages)
        .where(and(eq(mailMessages.companyId, companyId), eq(mailMessages.messageId, mid)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (parent?.threadId) return parent.threadId;
    }

    const normalized = normalizeSubject(input.subject);
    if (normalized && input.agentId) {
      const since = new Date(Date.now() - SUBJECT_THREAD_WINDOW_MS);
      const recent = await db
        .select({
          threadId: mailMessages.threadId,
          fromAddr: mailMessages.fromAddr,
          toAddrs: mailMessages.toAddrs,
          subject: mailMessages.subject,
        })
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.companyId, companyId),
            eq(mailMessages.agentId, input.agentId),
            gt(mailMessages.createdAt, since),
          ),
        )
        .orderBy(desc(mailMessages.createdAt))
        .limit(50);
      const mine = new Set(input.participants.map((p) => p.toLowerCase()));
      for (const r of recent) {
        if (!r.threadId || normalizeSubject(r.subject) !== normalized) continue;
        const theirs = [r.fromAddr, ...(r.toAddrs ?? [])].map((p) => p.toLowerCase());
        if (theirs.some((p) => mine.has(p))) return r.threadId;
      }
    }

    return randomUUID();
  }

  /** Folder membership predicate (shared by list + counts). */
  function folderConditions(companyId: string, agentId: string, folder: MailFolder) {
    const base = [eq(mailMessages.companyId, companyId), eq(mailMessages.agentId, agentId)];
    switch (folder) {
      case "inbox":
        return [
          ...base,
          eq(mailMessages.direction, "inbound"),
          isNull(mailMessages.deletedAt),
          eq(mailMessages.isArchived, false),
        ];
      case "sent":
        return [
          ...base,
          eq(mailMessages.direction, "outbound"),
          inArray(mailMessages.status, ["queued", "sending", "sent", "failed", "bounced"]),
          isNull(mailMessages.deletedAt),
        ];
      case "drafts":
        return [...base, eq(mailMessages.status, "draft"), isNull(mailMessages.deletedAt)];
      case "starred":
        return [...base, eq(mailMessages.isStarred, true), isNull(mailMessages.deletedAt)];
      case "archive":
        return [...base, eq(mailMessages.isArchived, true), isNull(mailMessages.deletedAt)];
      case "trash":
        return [...base, sql`${mailMessages.deletedAt} is not null`];
    }
  }

  async function attachmentsByMessageIds(messageIds: string[]): Promise<Map<string, MailAttachmentRow[]>> {
    const map = new Map<string, MailAttachmentRow[]>();
    if (messageIds.length === 0) return map;
    const rows = await db
      .select()
      .from(mailMessageAttachments)
      .where(inArray(mailMessageAttachments.mailMessageId, messageIds));
    for (const r of rows) {
      if (!r.mailMessageId) continue;
      map.set(r.mailMessageId, [...(map.get(r.mailMessageId) ?? []), r]);
    }
    return map;
  }

  return {
    /** Store a parsed inbound message (called by the SMTP listener). */
    recordInbound: async (companyId: string, input: RecordInboundInput): Promise<MailMessage> => {
      const threadId = await resolveThreadId(companyId, {
        agentId: input.agentId,
        inReplyTo: input.inReplyTo,
        references: input.references,
        subject: input.subject,
        participants: [input.fromAddr, ...input.toAddrs],
      });
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
          bccAddrs: input.bccAddrs ?? [],
          subject: input.subject ?? null,
          textBody: input.textBody ?? null,
          htmlBody: input.htmlBody ?? null,
          headers: input.headers ?? {},
          messageId: input.messageId ?? null,
          inReplyTo: input.inReplyTo ?? null,
          references: input.references ?? null,
          threadId,
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
      return rows.map((r) => toMailMessage(r));
    },

    /** Folder/search/paginated/threaded list for the mail client. */
    listFolder: async (
      companyId: string,
      agentId: string,
      query: MailListQuery,
    ): Promise<MailListPage<MailMessageListItem | MailThreadSummary>> => {
      const conditions = folderConditions(companyId, agentId, query.folder);
      if (query.status) conditions.push(eq(mailMessages.status, query.status));
      if (query.starred !== undefined) conditions.push(eq(mailMessages.isStarred, query.starred));
      if (query.q) {
        const like = `%${query.q}%`;
        conditions.push(
          or(
            ilike(mailMessages.fromAddr, like),
            ilike(mailMessages.subject, like),
            ilike(mailMessages.textBody, like),
          )!,
        );
      }
      const cursor = decodeCursor(query.cursor);
      const keyset = cursor
        ? sql`(${mailMessages.createdAt}, ${mailMessages.id}) < (${cursor.createdAt.toISOString()}, ${cursor.id})`
        : undefined;

      // Threaded mode: one representative row per thread = the latest message of
      // the thread within this folder (no newer sibling in the same folder).
      const threaded = query.threaded && query.folder !== "drafts";
      if (threaded) {
        const newerSibling = sql`exists (select 1 from ${mailMessages} m2 where m2.thread_id = ${mailMessages.threadId} and m2.company_id = ${mailMessages.companyId} and m2.agent_id = ${mailMessages.agentId} and m2.direction = ${mailMessages.direction} and m2.deleted_at is null and (m2.created_at, m2.id) > (${mailMessages.createdAt}, ${mailMessages.id}))`;
        const repConditions = [...conditions, sql`not ${newerSibling}`];
        if (keyset) repConditions.push(keyset);
        const reps = await db
          .select()
          .from(mailMessages)
          .where(and(...repConditions))
          .orderBy(desc(mailMessages.createdAt), desc(mailMessages.id))
          .limit(query.limit + 1);
        const hasMore = reps.length > query.limit;
        const page = hasMore ? reps.slice(0, query.limit) : reps;
        const threadIds = page.map((r) => r.threadId).filter((t): t is string => Boolean(t));
        const aggs =
          threadIds.length > 0
            ? await db
                .select({
                  threadId: mailMessages.threadId,
                  messageCount: sql<number>`count(*)::int`,
                  unreadCount: sql<number>`sum(case when ${mailMessages.status} = 'received' then 1 else 0 end)::int`,
                  isStarred: sql<boolean>`bool_or(${mailMessages.isStarred})`,
                })
                .from(mailMessages)
                .where(
                  and(
                    eq(mailMessages.companyId, companyId),
                    eq(mailMessages.agentId, agentId),
                    isNull(mailMessages.deletedAt),
                    inArray(mailMessages.threadId, threadIds),
                  ),
                )
                .groupBy(mailMessages.threadId)
            : [];
        const aggMap = new Map(aggs.map((a) => [a.threadId, a]));
        const attachMap = await attachmentsByMessageIds(page.map((r) => r.id));
        const items: MailThreadSummary[] = page.map((r) => {
          const agg = r.threadId ? aggMap.get(r.threadId) : undefined;
          return {
            threadId: r.threadId ?? r.id,
            subject: r.subject,
            snippet: snippetOf(r),
            lastMessageAt: r.createdAt,
            messageCount: agg?.messageCount ?? 1,
            unreadCount: agg?.unreadCount ?? 0,
            participants: [r.fromAddr, ...(r.toAddrs ?? [])],
            hasAttachments: (attachMap.get(r.id) ?? []).length > 0,
            isStarred: agg?.isStarred ?? r.isStarred,
            lastStatus: r.status as MailThreadSummary["lastStatus"],
            lastError: r.error,
          };
        });
        const last = page[page.length - 1];
        return { items, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null };
      }

      const flatConditions = keyset ? [...conditions, keyset] : conditions;
      const rows = await db
        .select()
        .from(mailMessages)
        .where(and(...flatConditions))
        .orderBy(desc(mailMessages.createdAt), desc(mailMessages.id))
        .limit(query.limit + 1);
      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const attachMap = await attachmentsByMessageIds(page.map((r) => r.id));
      const items = page.map((r) => toMailListItem(r, (attachMap.get(r.id) ?? []).length > 0));
      const last = page[page.length - 1];
      return { items, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null };
    },

    /** All messages of a conversation, ascending, with attachments. */
    getThread: async (companyId: string, agentId: string, threadId: string): Promise<MailThread> => {
      const rows = await db
        .select()
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.companyId, companyId),
            eq(mailMessages.agentId, agentId),
            eq(mailMessages.threadId, threadId),
            isNull(mailMessages.deletedAt),
          ),
        )
        .orderBy(asc(mailMessages.createdAt));
      if (rows.length === 0) throw notFound("Thread not found");
      const attachMap = await attachmentsByMessageIds(rows.map((r) => r.id));
      return {
        threadId,
        subject: rows[0].subject,
        messages: rows.map((r) => toMailMessage(r, attachMap.get(r.id) ?? [])),
      };
    },

    /** Unread counts per folder for the rail badges. */
    folderCounts: async (companyId: string, agentId: string): Promise<MailFolderCounts> => {
      const countFolder = async (folder: MailFolder, unreadOnly: boolean): Promise<number> => {
        const conds = folderConditions(companyId, agentId, folder);
        if (unreadOnly) conds.push(eq(mailMessages.status, "received"));
        const [{ n }] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(mailMessages)
          .where(and(...conds));
        return n;
      };
      const [inbox, drafts, starred, archive, trash] = await Promise.all([
        countFolder("inbox", true),
        countFolder("drafts", false),
        countFolder("starred", false),
        countFolder("archive", false),
        countFolder("trash", false),
      ]);
      return { inbox, drafts, starred, archive, trash };
    },

    getById: async (companyId: string, id: string): Promise<MailMessage> => {
      const row = await db
        .select()
        .from(mailMessages)
        .where(and(eq(mailMessages.id, id), eq(mailMessages.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Message not found");
      const attachMap = await attachmentsByMessageIds([id]);
      return toMailMessage(row, attachMap.get(id) ?? []);
    },

    /** Queue an outbound message for the worker to deliver. */
    enqueueOutbound: async (companyId: string, input: EnqueueOutboundInput): Promise<MailMessage> => {
      const senderDomain = input.fromAddr.split("@")[1] ?? "localhost";
      const messageId = `<${randomUUID()}@${senderDomain}>`;
      const threadId = await resolveThreadId(companyId, {
        agentId: input.agentId,
        inReplyTo: input.inReplyTo,
        references: input.references,
        subject: input.subject,
        participants: [input.fromAddr, ...input.toAddrs],
      });
      const row = await db
        .insert(mailMessages)
        .values({
          companyId,
          addressId: input.addressId,
          agentId: input.agentId,
          direction: "outbound",
          status: "queued",
          messageId,
          fromAddr: input.fromAddr,
          toAddrs: input.toAddrs,
          ccAddrs: input.ccAddrs ?? [],
          bccAddrs: input.bccAddrs ?? [],
          subject: input.subject ?? null,
          textBody: input.textBody ?? null,
          htmlBody: input.htmlBody ?? null,
          inReplyTo: input.inReplyTo ?? null,
          references: input.references ?? null,
          threadId,
          nextAttemptAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]);
      if (input.attachmentIds && input.attachmentIds.length > 0) {
        await db
          .update(mailMessageAttachments)
          .set({ mailMessageId: row.id, updatedAt: new Date() })
          .where(
            and(
              eq(mailMessageAttachments.companyId, companyId),
              isNull(mailMessageAttachments.mailMessageId),
              inArray(mailMessageAttachments.id, input.attachmentIds),
            ),
          );
      }
      const attachMap = await attachmentsByMessageIds([row.id]);
      return toMailMessage(row, attachMap.get(row.id) ?? []);
    },

    /** Claim due outbound messages, atomically marking them `sending`. */
    claimDueOutbound: async (now: Date, limit: number): Promise<MailMessageRow[]> => {
      const due = await db
        .select({ id: mailMessages.id })
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.direction, "outbound"),
            inArray(mailMessages.status, ["queued", "failed"]),
            or(isNull(mailMessages.nextAttemptAt), lte(mailMessages.nextAttemptAt, now)),
          ),
        )
        .limit(limit);
      if (due.length === 0) return [];
      const ids = due.map((d) => d.id);
      return db
        .update(mailMessages)
        .set({ status: "sending", updatedAt: new Date() })
        .where(and(inArray(mailMessages.id, ids), inArray(mailMessages.status, ["queued", "failed"])))
        .returning();
    },

    markSent: async (id: string): Promise<void> => {
      await db
        .update(mailMessages)
        .set({ status: "sent", sentAt: new Date(), error: null, updatedAt: new Date() })
        .where(eq(mailMessages.id, id));
    },

    /** Mark a send attempt failed: retry with backoff, or give up after the cap. */
    markFailed: async (id: string, message: string): Promise<void> => {
      const row = await db
        .select({ attempts: mailMessages.attempts })
        .from(mailMessages)
        .where(eq(mailMessages.id, id))
        .then((rows) => rows[0]);
      const attempts = (row?.attempts ?? 0) + 1;
      const giveUp = attempts >= MAX_SEND_ATTEMPTS;
      const backoffMs = Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** attempts);
      await db
        .update(mailMessages)
        .set({
          status: giveUp ? "bounced" : "failed",
          attempts,
          error: message.slice(0, 500),
          nextAttemptAt: giveUp ? null : new Date(Date.now() + backoffMs),
          updatedAt: new Date(),
        })
        .where(eq(mailMessages.id, id));
    },

    /** Re-queue a failed/bounced outbound message for another delivery attempt. */
    retry: async (companyId: string, id: string): Promise<MailMessage> => {
      const row = await db
        .select()
        .from(mailMessages)
        .where(and(eq(mailMessages.id, id), eq(mailMessages.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Message not found");
      if (row.direction !== "outbound" || !["failed", "bounced"].includes(row.status)) {
        throw unprocessable("Only failed or bounced messages can be retried");
      }
      await db
        .update(mailMessages)
        .set({ status: "queued", attempts: 0, error: null, nextAttemptAt: new Date(), updatedAt: new Date() })
        .where(eq(mailMessages.id, id));
      const attachMap = await attachmentsByMessageIds([id]);
      return toMailMessage({ ...row, status: "queued", attempts: 0, error: null }, attachMap.get(id) ?? []);
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

    /** Set any subset of the Gmail-like flags (star / archive / read-unread). */
    setFlags: async (
      companyId: string,
      id: string,
      flags: { isStarred?: boolean; isArchived?: boolean; isRead?: boolean },
    ): Promise<MailMessage> => {
      const existing = await db
        .select()
        .from(mailMessages)
        .where(and(eq(mailMessages.id, id), eq(mailMessages.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Message not found");
      const patch: Partial<MailMessageRow> = { updatedAt: new Date() };
      if (flags.isStarred !== undefined) patch.isStarred = flags.isStarred;
      if (flags.isArchived !== undefined) patch.isArchived = flags.isArchived;
      if (flags.isRead !== undefined && existing.direction === "inbound") {
        patch.status = flags.isRead ? "read" : "received";
        patch.readAt = flags.isRead ? new Date() : null;
      }
      const row = await db
        .update(mailMessages)
        .set(patch)
        .where(and(eq(mailMessages.id, id), eq(mailMessages.companyId, companyId)))
        .returning()
        .then((rows) => rows[0]);
      const attachMap = await attachmentsByMessageIds([id]);
      return toMailMessage(row, attachMap.get(id) ?? []);
    },

    /** Soft delete (move to Trash). */
    trash: async (companyId: string, id: string): Promise<MailMessage> => {
      const row = await db
        .update(mailMessages)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(mailMessages.id, id), eq(mailMessages.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Message not found");
      return toMailMessage(row);
    },

    /** Restore from Trash. */
    restore: async (companyId: string, id: string): Promise<MailMessage> => {
      const row = await db
        .update(mailMessages)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(and(eq(mailMessages.id, id), eq(mailMessages.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Message not found");
      return toMailMessage(row);
    },

    /**
     * Permanently delete a message and return its attachment object keys so the
     * caller can remove the bytes from storage.
     */
    hardDelete: async (companyId: string, id: string): Promise<{ objectKeys: string[] }> => {
      const exists = await db
        .select({ id: mailMessages.id })
        .from(mailMessages)
        .where(and(eq(mailMessages.id, id), eq(mailMessages.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!exists) throw notFound("Message not found");
      const attachments = await db
        .select({ objectKey: mailMessageAttachments.objectKey })
        .from(mailMessageAttachments)
        .where(eq(mailMessageAttachments.mailMessageId, id));
      await db.delete(mailMessages).where(eq(mailMessages.id, id));
      return { objectKeys: attachments.map((a) => a.objectKey) };
    },

    // ─── Drafts ───────────────────────────────────────────────────────────────

    saveDraft: async (companyId: string, agentId: string, input: SaveDraftInput): Promise<MailMessage> => {
      const row = await db
        .insert(mailMessages)
        .values({
          companyId,
          addressId: input.addressId,
          agentId,
          direction: "outbound",
          status: "draft",
          fromAddr: input.fromAddr,
          toAddrs: input.toAddrs ?? [],
          ccAddrs: input.ccAddrs ?? [],
          bccAddrs: input.bccAddrs ?? [],
          subject: input.subject ?? null,
          textBody: input.textBody ?? null,
          htmlBody: input.htmlBody ?? null,
          inReplyTo: input.inReplyTo ?? null,
          references: input.references ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
      return toMailMessage(row);
    },

    updateDraft: async (
      companyId: string,
      id: string,
      input: Partial<SaveDraftInput>,
    ): Promise<MailMessage> => {
      const existing = await db
        .select()
        .from(mailMessages)
        .where(and(eq(mailMessages.id, id), eq(mailMessages.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Draft not found");
      if (existing.status !== "draft") throw unprocessable("Not a draft");
      const row = await db
        .update(mailMessages)
        .set({
          ...(input.addressId ? { addressId: input.addressId } : {}),
          ...(input.fromAddr ? { fromAddr: input.fromAddr } : {}),
          ...(input.toAddrs ? { toAddrs: input.toAddrs } : {}),
          ...(input.ccAddrs ? { ccAddrs: input.ccAddrs } : {}),
          ...(input.bccAddrs ? { bccAddrs: input.bccAddrs } : {}),
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.textBody !== undefined ? { textBody: input.textBody } : {}),
          ...(input.htmlBody !== undefined ? { htmlBody: input.htmlBody } : {}),
          ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
          ...(input.references !== undefined ? { references: input.references } : {}),
          updatedAt: new Date(),
        })
        .where(eq(mailMessages.id, id))
        .returning()
        .then((rows) => rows[0]);
      const attachMap = await attachmentsByMessageIds([id]);
      return toMailMessage(row, attachMap.get(id) ?? []);
    },

    /** Promote a draft to the outbound queue. */
    sendDraft: async (companyId: string, id: string): Promise<MailMessage> => {
      const existing = await db
        .select()
        .from(mailMessages)
        .where(and(eq(mailMessages.id, id), eq(mailMessages.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Draft not found");
      if (existing.status !== "draft") throw unprocessable("Not a draft");
      if (!existing.toAddrs || existing.toAddrs.length === 0) {
        throw unprocessable("Draft has no recipients");
      }
      const senderDomain = existing.fromAddr.split("@")[1] ?? "localhost";
      const messageId = existing.messageId ?? `<${randomUUID()}@${senderDomain}>`;
      const row = await db
        .update(mailMessages)
        .set({ status: "queued", messageId, nextAttemptAt: new Date(), attempts: 0, error: null, updatedAt: new Date() })
        .where(eq(mailMessages.id, id))
        .returning()
        .then((rows) => rows[0]);
      const attachMap = await attachmentsByMessageIds([id]);
      return toMailMessage(row, attachMap.get(id) ?? []);
    },

    // ─── Attachments ────────────────────────────────────────────────────────

    /** Record an attachment whose bytes were already stored (inbound or staged outbound). */
    recordAttachment: async (
      companyId: string,
      mailMessageId: string | null,
      input: InboundAttachmentInput,
    ): Promise<MailAttachment> => {
      const row = await db
        .insert(mailMessageAttachments)
        .values({
          companyId,
          mailMessageId,
          direction: input.direction,
          provider: input.provider,
          objectKey: input.objectKey,
          contentType: input.contentType,
          byteSize: input.byteSize,
          sha256: input.sha256,
          originalFilename: input.originalFilename,
          contentId: input.contentId ?? null,
          inline: input.inline ?? false,
        })
        .returning()
        .then((rows) => rows[0]);
      return toMailAttachment(row);
    },

    listAttachmentsForMessage: async (messageId: string): Promise<MailAttachmentRow[]> => {
      return db
        .select()
        .from(mailMessageAttachments)
        .where(eq(mailMessageAttachments.mailMessageId, messageId));
    },

    getAttachmentById: async (companyId: string, id: string): Promise<MailAttachmentRow> => {
      const row = await db
        .select()
        .from(mailMessageAttachments)
        .where(and(eq(mailMessageAttachments.id, id), eq(mailMessageAttachments.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Attachment not found");
      return row;
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
        "API (Authorization: Bearer $PAPERCLIP_API_KEY, base $PAPERCLIP_API_URL/api):",
        "- read: GET /agents/$PAPERCLIP_AGENT_ID/email/inbox and /agents/$PAPERCLIP_AGENT_ID/email/messages/<id>",
        "- your addresses: GET /agents/$PAPERCLIP_AGENT_ID/email/addresses (use an id as fromAddressId)",
        '- reply/send: POST /agents/$PAPERCLIP_AGENT_ID/email/send {"fromAddressId":"<id>","to":["..."],"subject":"...","text":"...","inReplyTo":"<messageId of the email you reply to>"}',
        "- mark read: POST /agents/$PAPERCLIP_AGENT_ID/email/messages/<id>/read",
      ].join("\n");
    },
  };
}
