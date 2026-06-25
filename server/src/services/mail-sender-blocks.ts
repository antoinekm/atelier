import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { mailSenderBlocks } from "@paperclipai/db";
import type { CreateSenderBlock, MailSenderBlock } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { senderMatches } from "../mail/sender-match.js";

const CACHE_TTL_MS = 30_000;

type MailSenderBlockRow = typeof mailSenderBlocks.$inferSelect;

export interface MailSenderBlockActor {
  actorType: "user" | "agent";
  actorId: string;
}

function toMailSenderBlock(row: MailSenderBlockRow): MailSenderBlock {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind as MailSenderBlock["kind"],
    value: row.value,
    reason: row.reason,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}

// Per-company cache of {kind,value} blocks so the SMTP path does not hit the DB
// on every RCPT. Invalidated on add/remove; otherwise refreshed every TTL.
const cache = new Map<string, { at: number; entries: { kind: "address" | "domain"; value: string }[] }>();

export function mailSenderBlockService(db: Db) {
  async function load(companyId: string): Promise<{ kind: "address" | "domain"; value: string }[]> {
    const cached = cache.get(companyId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.entries;
    const rows = await db
      .select({ kind: mailSenderBlocks.kind, value: mailSenderBlocks.value })
      .from(mailSenderBlocks)
      .where(eq(mailSenderBlocks.companyId, companyId));
    const entries = rows.map((r) => ({ kind: r.kind as "address" | "domain", value: r.value }));
    cache.set(companyId, { at: Date.now(), entries });
    return entries;
  }

  return {
    list: async (companyId: string): Promise<MailSenderBlock[]> => {
      const rows = await db
        .select()
        .from(mailSenderBlocks)
        .where(eq(mailSenderBlocks.companyId, companyId))
        .orderBy(desc(mailSenderBlocks.createdAt));
      return rows.map(toMailSenderBlock);
    },

    add: async (
      companyId: string,
      input: CreateSenderBlock,
      actor: MailSenderBlockActor,
    ): Promise<MailSenderBlock> => {
      const value = input.value.trim().toLowerCase();
      const row = await db
        .insert(mailSenderBlocks)
        .values({
          companyId,
          kind: input.kind,
          value,
          reason: input.reason ?? null,
          createdByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        })
        .onConflictDoNothing({
          target: [mailSenderBlocks.companyId, mailSenderBlocks.kind, mailSenderBlocks.value],
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      cache.delete(companyId);
      // Idempotent: if it already existed, return the existing row.
      if (!row) {
        const existing = await db
          .select()
          .from(mailSenderBlocks)
          .where(
            and(
              eq(mailSenderBlocks.companyId, companyId),
              eq(mailSenderBlocks.kind, input.kind),
              eq(mailSenderBlocks.value, value),
            ),
          )
          .then((rows) => rows[0] ?? null);
        // Lost a race with a concurrent remove between the conflict and this read.
        if (!existing) throw notFound("Block not found");
        return toMailSenderBlock(existing);
      }
      return toMailSenderBlock(row);
    },

    remove: async (companyId: string, id: string): Promise<void> => {
      const deleted = await db
        .delete(mailSenderBlocks)
        .where(and(eq(mailSenderBlocks.id, id), eq(mailSenderBlocks.companyId, companyId)))
        .returning({ id: mailSenderBlocks.id });
      cache.delete(companyId);
      if (deleted.length === 0) throw notFound("Block not found");
    },

    /** Whether a sender is blocked for a company (cached; used by the SMTP listener). */
    isBlocked: async (companyId: string, sender: string | undefined): Promise<boolean> => {
      const s = (sender ?? "").trim().toLowerCase();
      if (!s) return false;
      const entries = await load(companyId);
      return entries.some((e) => senderMatches(s, e.kind, e.value));
    },
  };
}
