import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, mailAddresses, mailDomains, mailMessages } from "@paperclipai/db";
import { mailAddressService } from "../services/mail-addresses.ts";
import { mailMessageService } from "../services/mail-messages.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const boardActor = { actorType: "user" as const, actorId: "board" };

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("mail reception (embedded mail, phase 1)", () => {
  let db!: ReturnType<typeof createDb>;
  let addresses!: ReturnType<typeof mailAddressService>;
  let messages!: ReturnType<typeof mailMessageService>;
  let stopDb: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("atelier-mail-rx-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    addresses = mailAddressService(db);
    messages = mailMessageService(db);
  }, 20_000);

  afterEach(async () => {
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
    return { companyId, agentId, domainId };
  }

  it("creates an agent address and resolves recipients (exact + catch-all)", async () => {
    const { companyId, agentId, domainId } = await seed();

    const mailbox = await addresses.create(companyId, agentId, { domainId, localPart: "ceo" }, boardActor);
    expect(mailbox.address).toBe("ceo@example.com");
    expect(mailbox.kind).toBe("mailbox");

    // An agent can hold several addresses.
    await addresses.create(companyId, agentId, { domainId, localPart: "sales" }, boardActor);
    expect(await addresses.list(companyId, { agentId })).toHaveLength(2);

    // Exact match.
    const exact = await addresses.resolveRecipient("ceo@example.com");
    expect(exact?.id).toBe(mailbox.id);

    // No catch-all yet -> unknown recipient rejected.
    expect(await addresses.resolveRecipient("nope@example.com")).toBeNull();

    // Add a catch-all -> unknown recipients now resolve to it.
    const catchAll = await addresses.create(companyId, agentId, { domainId, localPart: "*" }, boardActor);
    expect(catchAll.kind).toBe("catch_all");
    const resolved = await addresses.resolveRecipient("anything@example.com");
    expect(resolved?.id).toBe(catchAll.id);
  });

  it("records inbound mail, lists the inbox, and marks read", async () => {
    const { companyId, agentId, domainId } = await seed();
    const mailbox = await addresses.create(companyId, agentId, { domainId, localPart: "ceo" }, boardActor);

    await messages.recordInbound(companyId, {
      addressId: mailbox.id,
      agentId,
      fromAddr: "human@founder.com",
      toAddrs: ["ceo@example.com"],
      subject: "Hello agent",
      textBody: "Please reply when you can.",
    });

    const inbox = await messages.listInbox(companyId, agentId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].subject).toBe("Hello agent");
    expect(inbox[0].status).toBe("received");

    // Run-context summary is non-empty while unread.
    expect(await messages.buildRunEmailSummary(companyId, agentId)).toContain("unread email");

    const read = await messages.markRead(companyId, inbox[0].id);
    expect(read.status).toBe("read");
    // Once read, it drops out of the unread summary.
    expect(await messages.buildRunEmailSummary(companyId, agentId)).toBe("");
  });
});
