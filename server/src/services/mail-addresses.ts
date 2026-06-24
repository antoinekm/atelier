import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { mailAddresses, mailDomains } from "@paperclipai/db";
import type { CreateMailAddress, MailAddress } from "@paperclipai/shared";
import { badRequest, conflict, notFound } from "../errors.js";

export type MailAddressActor = { actorType: "user" | "agent"; actorId: string };

type MailAddressRow = typeof mailAddresses.$inferSelect;

function toMailAddress(row: MailAddressRow): MailAddress {
  return {
    id: row.id,
    companyId: row.companyId,
    domainId: row.domainId,
    agentId: row.agentId,
    localPart: row.localPart,
    address: row.address,
    kind: row.kind as MailAddress["kind"],
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mailAddressService(db: Db) {
  return {
    /** Create an address (mailbox / catch-all) for an agent or the company. */
    create: async (
      companyId: string,
      agentId: string | null,
      input: CreateMailAddress,
      actor: MailAddressActor,
    ): Promise<MailAddress> => {
      const domain = await db
        .select()
        .from(mailDomains)
        .where(and(eq(mailDomains.id, input.domainId), eq(mailDomains.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!domain) throw notFound("Mail domain not found");

      const localPart = input.localPart.trim().toLowerCase();
      const kind = input.kind ?? (localPart === "*" ? "catch_all" : "mailbox");
      if ((kind === "catch_all") !== (localPart === "*")) {
        throw badRequest("Catch-all addresses must use local part '*' (and vice versa)");
      }
      const address = `${localPart}@${domain.domain}`;

      const existing = await db
        .select()
        .from(mailAddresses)
        .where(eq(mailAddresses.address, address))
        .then((rows) => rows[0] ?? null);
      if (existing) throw conflict(`Address already exists: ${address}`);

      const row = await db
        .insert(mailAddresses)
        .values({
          companyId,
          domainId: domain.id,
          agentId,
          localPart,
          address,
          kind,
          createdByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        })
        .returning()
        .then((rows) => rows[0]);
      return toMailAddress(row);
    },

    list: async (companyId: string, opts?: { agentId?: string | null }): Promise<MailAddress[]> => {
      const conditions = [eq(mailAddresses.companyId, companyId)];
      if (opts && opts.agentId !== undefined) {
        conditions.push(
          opts.agentId === null ? eq(mailAddresses.agentId, null as never) : eq(mailAddresses.agentId, opts.agentId),
        );
      }
      const rows = await db
        .select()
        .from(mailAddresses)
        .where(and(...conditions))
        .orderBy(desc(mailAddresses.createdAt));
      return rows.map(toMailAddress);
    },

    getById: async (companyId: string, id: string): Promise<MailAddress> => {
      const row = await db
        .select()
        .from(mailAddresses)
        .where(and(eq(mailAddresses.id, id), eq(mailAddresses.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Mail address not found");
      return toMailAddress(row);
    },

    /**
     * Resolve an incoming recipient address to a stored row: exact match first,
     * then a catch-all on the same domain. Used by the inbound SMTP listener to
     * reject unknown recipients (no open relay) and to attribute the message.
     */
    resolveRecipient: async (address: string): Promise<MailAddressRow | null> => {
      const normalized = address.trim().toLowerCase();
      const exact = await db
        .select()
        .from(mailAddresses)
        .where(and(eq(mailAddresses.address, normalized), eq(mailAddresses.status, "active")))
        .then((rows) => rows[0] ?? null);
      if (exact) return exact;
      const at = normalized.lastIndexOf("@");
      if (at < 0) return null;
      const domain = normalized.slice(at + 1);
      return db
        .select()
        .from(mailAddresses)
        .where(and(eq(mailAddresses.address, `*@${domain}`), eq(mailAddresses.status, "active")))
        .then((rows) => rows[0] ?? null);
    },

    remove: async (companyId: string, id: string): Promise<void> => {
      const deleted = await db
        .delete(mailAddresses)
        .where(and(eq(mailAddresses.id, id), eq(mailAddresses.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!deleted) throw notFound("Mail address not found");
    },
  };
}
