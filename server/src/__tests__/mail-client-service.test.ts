import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, mailAddresses, mailDomains, mailMessages, mailMessageAttachments } from "@paperclipai/db";
import { mailAddressService } from "../services/mail-addresses.ts";
import { mailMessageService } from "../services/mail-messages.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const boardActor = { actorType: "user" as const, actorId: "board" };
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("mail client (folders, threading, flags, drafts, attachments)", () => {
  let db!: ReturnType<typeof createDb>;
  let addresses!: ReturnType<typeof mailAddressService>;
  let messages!: ReturnType<typeof mailMessageService>;
  let stopDb: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("atelier-mail-client-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    addresses = mailAddressService(db);
    messages = mailMessageService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(mailMessageAttachments);
    await db.delete(mailMessages);
    await db.delete(mailAddresses);
    await db.delete(mailDomains);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Atelier",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "CEO", role: "ceo" });
    const domainId = randomUUID();
    await db.insert(mailDomains).values({
      id: domainId,
      companyId,
      domain: "example.com",
      cfZoneId: "zone1",
      status: "active",
      dkimSelector: "atl1",
    });
    const addr = await addresses.create(companyId, agentId, { domainId, localPart: "ceo" }, boardActor);
    return { companyId, agentId, addr };
  }

  it("threads an inbound reply to an outbound message via In-Reply-To", async () => {
    const { companyId, agentId, addr } = await seed();
    const sent = await messages.enqueueOutbound(companyId, {
      addressId: addr.id,
      agentId,
      fromAddr: addr.address,
      toAddrs: ["human@founder.com"],
      subject: "Status update",
      textBody: "All green.",
    });
    expect(sent.messageId).toBeTruthy();

    const reply = await messages.recordInbound(companyId, {
      addressId: addr.id,
      agentId,
      fromAddr: "human@founder.com",
      toAddrs: ["ceo@example.com"],
      subject: "Re: Status update",
      textBody: "Thanks!",
      inReplyTo: sent.messageId,
    });
    expect(reply.threadId).toBe(sent.threadId);

    const thread = await messages.getThread(companyId, agentId, sent.threadId!);
    expect(thread.messages).toHaveLength(2);
  });

  it("lists folders with keyset pagination and routes messages to the right folder", async () => {
    const { companyId, agentId, addr } = await seed();
    for (let i = 0; i < 5; i++) {
      await messages.recordInbound(companyId, {
        addressId: addr.id,
        agentId,
        fromAddr: `sender${i}@founder.com`,
        toAddrs: ["ceo@example.com"],
        subject: `Msg ${i}`,
        textBody: `body ${i}`,
      });
    }
    const page1 = await messages.listFolder(companyId, agentId, { folder: "inbox", limit: 2, threaded: false });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await messages.listFolder(companyId, agentId, {
      folder: "inbox",
      limit: 2,
      threaded: false,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items).toHaveLength(2);
    const ids1 = new Set(page1.items.map((i) => i.id));
    expect(page2.items.every((i) => !ids1.has(i.id))).toBe(true);

    // Sent folder shows the outbound message only.
    await messages.enqueueOutbound(companyId, {
      addressId: addr.id,
      agentId,
      fromAddr: addr.address,
      toAddrs: ["x@y.com"],
      subject: "Out",
      textBody: "out",
    });
    const sent = await messages.listFolder(companyId, agentId, { folder: "sent", limit: 50, threaded: false });
    expect(sent.items).toHaveLength(1);
  });

  it("flags: star/archive/read move between folders and counts update", async () => {
    const { companyId, agentId, addr } = await seed();
    const m = await messages.recordInbound(companyId, {
      addressId: addr.id,
      agentId,
      fromAddr: "h@f.com",
      toAddrs: ["ceo@example.com"],
      subject: "Flag me",
      textBody: "x",
    });
    let counts = await messages.folderCounts(companyId, agentId);
    expect(counts.inbox).toBe(1);

    await messages.setFlags(companyId, m.id, { isRead: true });
    counts = await messages.folderCounts(companyId, agentId);
    expect(counts.inbox).toBe(0); // unread count drops

    await messages.setFlags(companyId, m.id, { isStarred: true });
    expect((await messages.listFolder(companyId, agentId, { folder: "starred", limit: 50, threaded: false })).items).toHaveLength(1);

    await messages.setFlags(companyId, m.id, { isArchived: true });
    expect((await messages.listFolder(companyId, agentId, { folder: "archive", limit: 50, threaded: false })).items).toHaveLength(1);
    // Archived leaves the inbox.
    expect((await messages.listFolder(companyId, agentId, { folder: "inbox", limit: 50, threaded: false })).items).toHaveLength(0);
  });

  it("trash + restore + hard delete", async () => {
    const { companyId, agentId, addr } = await seed();
    const m = await messages.recordInbound(companyId, {
      addressId: addr.id,
      agentId,
      fromAddr: "h@f.com",
      toAddrs: ["ceo@example.com"],
      subject: "Trash me",
      textBody: "x",
    });
    await messages.trash(companyId, m.id);
    expect((await messages.listFolder(companyId, agentId, { folder: "inbox", limit: 50, threaded: false })).items).toHaveLength(0);
    expect((await messages.listFolder(companyId, agentId, { folder: "trash", limit: 50, threaded: false })).items).toHaveLength(1);
    await messages.restore(companyId, m.id);
    expect((await messages.listFolder(companyId, agentId, { folder: "inbox", limit: 50, threaded: false })).items).toHaveLength(1);
    const { objectKeys } = await messages.hardDelete(companyId, m.id);
    expect(objectKeys).toEqual([]);
    await expect(messages.getById(companyId, m.id)).rejects.toThrow();
  });

  it("retry only works on failed/bounced; drafts can be saved, updated and sent", async () => {
    const { companyId, agentId, addr } = await seed();
    const sent = await messages.enqueueOutbound(companyId, {
      addressId: addr.id,
      agentId,
      fromAddr: addr.address,
      toAddrs: ["x@y.com"],
      textBody: "x",
    });
    await expect(messages.retry(companyId, sent.id)).rejects.toThrow(); // still queued
    await messages.markFailed(sent.id, "boom");
    await messages.markFailed(sent.id, "boom");
    await messages.markFailed(sent.id, "boom");
    await messages.markFailed(sent.id, "boom");
    await messages.markFailed(sent.id, "boom"); // -> bounced
    const retried = await messages.retry(companyId, sent.id);
    expect(retried.status).toBe("queued");

    // Drafts.
    const draft = await messages.saveDraft(companyId, agentId, {
      addressId: addr.id,
      fromAddr: addr.address,
      subject: "WIP",
    });
    expect(draft.status).toBe("draft");
    expect((await messages.listFolder(companyId, agentId, { folder: "drafts", limit: 50, threaded: false })).items).toHaveLength(1);
    // A draft is never claimed by the worker.
    expect((await messages.claimDueOutbound(new Date(), 10)).find((c) => c.id === draft.id)).toBeUndefined();

    const updated = await messages.updateDraft(companyId, draft.id, { toAddrs: ["dest@x.com"], textBody: "ready" });
    expect(updated.toAddrs).toEqual(["dest@x.com"]);
    const queued = await messages.sendDraft(companyId, draft.id);
    expect(queued.status).toBe("queued");
    expect(queued.messageId).toBeTruthy();
  });

  it("attachments: record, list, and link staged outbound attachments on enqueue", async () => {
    const { companyId, agentId, addr } = await seed();
    // Stage an attachment (no message yet).
    const staged = await messages.recordAttachment(companyId, null, {
      agentId,
      direction: "outbound",
      provider: "local_disk",
      objectKey: "mail/x/1-file.txt",
      contentType: "text/plain",
      byteSize: 4,
      sha256: "deadbeef",
      originalFilename: "file.txt",
    });
    expect(staged.mailMessageId).toBeNull();

    const sent = await messages.enqueueOutbound(companyId, {
      addressId: addr.id,
      agentId,
      fromAddr: addr.address,
      toAddrs: ["x@y.com"],
      subject: "With attachment",
      textBody: "see attached",
      attachmentIds: [staged.id],
    });
    expect(sent.attachments).toHaveLength(1);
    const linked = await messages.listAttachmentsForMessage(sent.id);
    expect(linked).toHaveLength(1);
    expect(linked[0].originalFilename).toBe("file.txt");
  });
});
