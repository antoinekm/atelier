import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companySecrets, companySecretVersions, createDb } from "@paperclipai/db";
import { mailOutboundGuard } from "../services/mail-outbound-guard.ts";
import { createInboundGuard } from "../mail/inbound-guard.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("inbound mail guard (allow/deny + rate limit)", () => {
  const saved = {
    deny: process.env.MAIL_SENDER_DENYLIST,
    allow: process.env.MAIL_SENDER_ALLOWLIST,
    rate: process.env.MAIL_INBOUND_RATE_PER_MIN,
  };
  afterEach(() => {
    for (const [k, v] of [
      ["MAIL_SENDER_DENYLIST", saved.deny],
      ["MAIL_SENDER_ALLOWLIST", saved.allow],
      ["MAIL_INBOUND_RATE_PER_MIN", saved.rate],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("denies by exact email and by domain (incl. subdomains)", () => {
    process.env.MAIL_SENDER_DENYLIST = "spammer@x.com, evil.com";
    delete process.env.MAIL_SENDER_ALLOWLIST;
    delete process.env.MAIL_INBOUND_RATE_PER_MIN;
    const guard = createInboundGuard();
    expect(guard.check("spammer@x.com").ok).toBe(false);
    expect(guard.check("anyone@evil.com").ok).toBe(false);
    expect(guard.check("anyone@mail.evil.com").ok).toBe(false);
    expect(guard.check("friend@good.com").ok).toBe(true);
  });

  it("allowlist makes reception exclusive", () => {
    delete process.env.MAIL_SENDER_DENYLIST;
    process.env.MAIL_SENDER_ALLOWLIST = "partner.com";
    delete process.env.MAIL_INBOUND_RATE_PER_MIN;
    const guard = createInboundGuard();
    expect(guard.check("ceo@partner.com").ok).toBe(true);
    expect(guard.check("stranger@elsewhere.com").ok).toBe(false);
  });

  it("rate-limits a single sender within the window", () => {
    delete process.env.MAIL_SENDER_DENYLIST;
    delete process.env.MAIL_SENDER_ALLOWLIST;
    process.env.MAIL_INBOUND_RATE_PER_MIN = "3";
    let t = 1_000_000;
    const guard = createInboundGuard(() => t);
    expect(guard.check("flood@x.com").ok).toBe(true);
    expect(guard.check("flood@x.com").ok).toBe(true);
    expect(guard.check("flood@x.com").ok).toBe(true);
    const blocked = guard.check("flood@x.com");
    expect(blocked.ok).toBe(false);
    expect(blocked.smtpError).toContain("421");
    // A different sender is unaffected.
    expect(guard.check("other@x.com").ok).toBe(true);
    // After the window slides, the flooder is allowed again.
    t += 61_000;
    expect(guard.check("flood@x.com").ok).toBe(true);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("outbound mail guard (secret exfiltration)", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("atelier-mail-sec-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedSecret(value: string): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Atelier",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const secretId = randomUUID();
    await db.insert(companySecrets).values({
      id: secretId,
      companyId,
      key: "STRIPE_SECRET_KEY",
      name: "STRIPE_SECRET_KEY",
      status: "active",
    });
    await db.insert(companySecretVersions).values({
      id: randomUUID(),
      secretId,
      version: 1,
      material: { scheme: "test", ciphertext: "x" },
      valueSha256: createHash("sha256").update(value).digest("hex"),
      fingerprintSha256: createHash("sha256").update(`fp:${value}`).digest("hex"),
      status: "current",
    });
    return companyId;
  }

  it("blocks an outbound body that contains a secret value, allows a clean one", async () => {
    const value = "sk_live_51HxQexfilthysecret9000";
    const companyId = await seedSecret(value);
    const guard = mailOutboundGuard(db);

    await expect(
      guard.assertNoSecretLeak(companyId, ["Here is the key", `the value is ${value} please use it`]),
    ).rejects.toThrow(/secret/i);

    // A normal reply with no secret passes.
    await expect(
      guard.assertNoSecretLeak(companyId, ["Re: hello", "Thanks, all good on my end."]),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when the company has no secrets", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Atelier",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await expect(
      mailOutboundGuard(db).assertNoSecretLeak(companyId, ["anything at all here"]),
    ).resolves.toBeUndefined();
  });
});
