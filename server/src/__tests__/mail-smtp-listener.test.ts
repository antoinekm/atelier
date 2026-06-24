import net from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, mailAddresses, mailDomains } from "@paperclipai/db";
import { mailAddressService } from "../services/mail-addresses.ts";
import { mailMessageService } from "../services/mail-messages.ts";
import { startMailListener, type MailListenerHandle } from "../mail/smtp-listener.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const boardActor = { actorType: "user" as const, actorId: "board" };
const SMTP_PORT = 12525;

/** Minimal promise-based SMTP client (read a full response, send a line). */
function smtpClient(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  let buffer = "";
  let resolveResp: ((s: string) => void) | null = null;
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\r\n").filter(Boolean);
    const last = lines[lines.length - 1];
    if (last && /^\d{3} /.test(last) && buffer.endsWith("\r\n")) {
      const resp = buffer;
      buffer = "";
      resolveResp?.(resp);
      resolveResp = null;
    }
  });
  const expect_ = () => new Promise<string>((res) => (resolveResp = res));
  return {
    expect: expect_,
    send: (line: string) => {
      socket.write(`${line}\r\n`);
      return expect_();
    },
    raw: (data: string) => socket.write(data),
    end: () => socket.end(),
  };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("mail SMTP listener (embedded mail, phase 1)", () => {
  let db!: ReturnType<typeof createDb>;
  let listener!: MailListenerHandle | null;
  let stopDb: (() => Promise<void>) | null = null;
  const prevEnabled = process.env.MAIL_ENABLED;
  const prevPort = process.env.MAIL_SMTP_PORT;
  const ctx = { companyId: "", agentId: "" };

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("atelier-mail-smtp-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);

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
    await mailAddressService(db).create(companyId, agentId, { domainId, localPart: "ceo" }, boardActor);
    ctx.companyId = companyId;
    ctx.agentId = agentId;

    process.env.MAIL_ENABLED = "true";
    process.env.MAIL_SMTP_PORT = String(SMTP_PORT);
    listener = startMailListener(db);
    // give the listener a moment to bind
    await new Promise((r) => setTimeout(r, 200));
  }, 25_000);

  afterAll(async () => {
    await listener?.close();
    await stopDb?.();
    if (prevEnabled === undefined) delete process.env.MAIL_ENABLED;
    else process.env.MAIL_ENABLED = prevEnabled;
    if (prevPort === undefined) delete process.env.MAIL_SMTP_PORT;
    else process.env.MAIL_SMTP_PORT = prevPort;
  });

  it("accepts a known recipient and stores the message; rejects an unknown one", async () => {
    expect(listener).not.toBeNull();

    // Deliver to the known address ceo@example.com.
    const c = smtpClient(SMTP_PORT);
    await c.expect(); // 220 greeting
    expect(await c.send("EHLO test.local")).toMatch(/^250/m);
    expect(await c.send("MAIL FROM:<human@founder.com>")).toMatch(/^250/);
    expect(await c.send("RCPT TO:<ceo@example.com>")).toMatch(/^250/);
    expect(await c.send("DATA")).toMatch(/^354/);
    const body = "Subject: Hello agent\r\nFrom: human@founder.com\r\nTo: ceo@example.com\r\n\r\nPlease reply.\r\n.\r\n";
    c.raw(body);
    expect(await c.expect()).toMatch(/^250/); // accepted + stored
    await c.send("QUIT").catch(() => undefined);
    c.end();

    const inbox = await mailMessageService(db).listInbox(ctx.companyId, ctx.agentId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].subject).toBe("Hello agent");
    expect(inbox[0].fromAddr).toContain("human@founder.com");

    // An unknown recipient is rejected (no open relay).
    const c2 = smtpClient(SMTP_PORT);
    await c2.expect();
    await c2.send("EHLO test.local");
    await c2.send("MAIL FROM:<human@founder.com>");
    expect(await c2.send("RCPT TO:<nobody@example.com>")).toMatch(/^550/);
    await c2.send("QUIT").catch(() => undefined);
    c2.end();
  }, 20_000);
});
