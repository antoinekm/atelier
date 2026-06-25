import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, mailAddresses, mailDomains, mailSenderBlocks } from "@paperclipai/db";
import { mailAddressService } from "../services/mail-addresses.ts";
import { mailMessageService } from "../services/mail-messages.ts";
import { mailSenderBlockService } from "../services/mail-sender-blocks.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const boardActor = { actorType: "user" as const, actorId: "board" };
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("mail sender blocklist + capability note", () => {
  let db!: ReturnType<typeof createDb>;
  let addresses!: ReturnType<typeof mailAddressService>;
  let blocks!: ReturnType<typeof mailSenderBlockService>;
  let messages!: ReturnType<typeof mailMessageService>;
  let stopDb: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("atelier-mail-block-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    addresses = mailAddressService(db);
    blocks = mailSenderBlockService(db);
    messages = mailMessageService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(mailSenderBlocks);
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
      domain: "victoire.run",
      cfZoneId: "zone1",
      status: "active",
      dkimSelector: "atl1",
    });
    return { companyId, agentId, domainId };
  }

  it("blocks an exact address and a whole domain (incl. subdomains), with cache invalidation", async () => {
    const { companyId } = await seed();

    await blocks.add(companyId, { kind: "domain", value: "evil.com" }, boardActor);
    expect(await blocks.isBlocked(companyId, "anyone@evil.com")).toBe(true);
    expect(await blocks.isBlocked(companyId, "x@mail.evil.com")).toBe(true);
    expect(await blocks.isBlocked(companyId, "friend@good.com")).toBe(false);

    const addr = await blocks.add(companyId, { kind: "address", value: "Spammer@X.com" }, boardActor);
    expect(addr.value).toBe("spammer@x.com"); // normalized
    expect(await blocks.isBlocked(companyId, "spammer@x.com")).toBe(true);
    expect(await blocks.isBlocked(companyId, "other@x.com")).toBe(false);

    expect(await blocks.list(companyId)).toHaveLength(2);

    // Removing invalidates the cache immediately.
    await blocks.remove(companyId, addr.id);
    expect(await blocks.isBlocked(companyId, "spammer@x.com")).toBe(false);
    expect(await blocks.isBlocked(companyId, "anyone@evil.com")).toBe(true);
  });

  it("is company-scoped and idempotent", async () => {
    const a = await seed();
    const b = await seed();
    await blocks.add(a.companyId, { kind: "domain", value: "evil.com" }, boardActor);
    expect(await blocks.isBlocked(a.companyId, "x@evil.com")).toBe(true);
    expect(await blocks.isBlocked(b.companyId, "x@evil.com")).toBe(false);

    // Adding the same block twice does not duplicate.
    await blocks.add(a.companyId, { kind: "domain", value: "evil.com" }, boardActor);
    expect(await blocks.list(a.companyId)).toHaveLength(1);
  });

  it("capability note is non-empty once the agent has an address and lists its domains", async () => {
    const { companyId, agentId, domainId } = await seed();
    // No address yet -> empty.
    expect(await messages.buildRunMailCapabilityNote(companyId, agentId)).toBe("");

    await addresses.create(companyId, agentId, { domainId, localPart: "ceo" }, boardActor);
    const note = await messages.buildRunMailCapabilityNote(companyId, agentId);
    expect(note).toContain("ceo@victoire.run");
    expect(note).toContain("victoire.run");
    expect(note).toContain("send email to anyone");
    expect(note).toContain("block");
  });
});
