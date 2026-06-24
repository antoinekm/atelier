import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  cloudflareConnections,
  companies,
  companySecrets,
  companySecretBindings,
  companySecretVersions,
  createDb,
  mailDomains,
} from "@paperclipai/db";
import { cloudflareService } from "../services/cloudflare.ts";
import { mailDomainService } from "../services/mail-domains.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const boardActor = { actorType: "user" as const, actorId: "board" };

/** A Cloudflare v4 API mock: returns the right envelope per path/method. */
function cloudflareFetchMock() {
  return vi.fn(async (input: URL | string, init?: { method?: string }) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const p = url.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    const ok = (result: unknown) =>
      ({ ok: true, status: 200, json: async () => ({ success: true, result }) }) as unknown as Response;

    // OAuth token endpoint (auth-code exchange + refresh) on dash.cloudflare.com.
    if (url.host === "dash.cloudflare.com" && url.pathname === "/oauth2/token") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "cf-access-1",
          refresh_token: "cf-refresh-1",
          expires_in: 3600,
          scope: "dns_records.edit zone.read offline_access",
        }),
      } as unknown as Response;
    }

    if (p === "/user/tokens/verify") return ok({ id: "tok1", status: "active" });
    if (p === "/accounts") return ok([{ id: "acct1", name: "Acme" }]);
    if (p === "/zones") {
      const name = url.searchParams.get("name");
      const zones = [{ id: "zone1", name: "example.com", status: "active" }];
      return ok(name ? zones.filter((z) => z.name === name) : zones);
    }
    if (/^\/zones\/[^/]+\/dns_records$/.test(p)) {
      if (method === "POST") return ok({ id: randomUUID() });
      return ok([]); // GET: no existing record -> caller will POST
    }
    if (/^\/zones\/[^/]+\/dns_records\/[^/]+$/.test(p)) return ok({ id: "rec1" });
    return { ok: false, status: 404, json: async () => ({ success: false, errors: [{ message: "not found" }] }) } as unknown as Response;
  });
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cloudflare + mail domains (embedded mail, phase 0)", () => {
  let db!: ReturnType<typeof createDb>;
  let cf!: ReturnType<typeof cloudflareService>;
  let mail!: ReturnType<typeof mailDomainService>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousMailHost = process.env.MAIL_HOSTNAME;
  const previousOAuthEnv = {
    id: process.env.CLOUDFLARE_OAUTH_CLIENT_ID,
    secret: process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
    scopes: process.env.CLOUDFLARE_OAUTH_SCOPES,
    redirect: process.env.CLOUDFLARE_OAUTH_REDIRECT_URI,
  };
  const secretsTmpDir = path.join(os.tmpdir(), `atelier-mail-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    process.env.MAIL_HOSTNAME = "mail.atelier.test";
    process.env.CLOUDFLARE_OAUTH_CLIENT_ID = "client-abc";
    process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET = "secret-xyz";
    process.env.CLOUDFLARE_OAUTH_SCOPES = "dns_records.edit zone.read offline_access";
    process.env.CLOUDFLARE_OAUTH_REDIRECT_URI = "https://atelier.test/api/integrations/cloudflare/oauth/callback";
    const started = await startEmbeddedPostgresTestDatabase("atelier-mail-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    cf = cloudflareService(db);
    mail = mailDomainService(db);
  }, 20_000);

  beforeEach(() => {
    vi.stubGlobal("fetch", cloudflareFetchMock());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(mailDomains);
    await db.delete(cloudflareConnections);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (previousMailHost === undefined) delete process.env.MAIL_HOSTNAME;
    else process.env.MAIL_HOSTNAME = previousMailHost;
    const restore = (key: string, val: string | undefined) =>
      val === undefined ? delete process.env[key] : (process.env[key] = val);
    restore("CLOUDFLARE_OAUTH_CLIENT_ID", previousOAuthEnv.id);
    restore("CLOUDFLARE_OAUTH_CLIENT_SECRET", previousOAuthEnv.secret);
    restore("CLOUDFLARE_OAUTH_SCOPES", previousOAuthEnv.scopes);
    restore("CLOUDFLARE_OAUTH_REDIRECT_URI", previousOAuthEnv.redirect);
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Atelier",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("connects Cloudflare, storing the token as a secret (never on the connection row)", async () => {
    const companyId = await seedCompany();
    const conn = await cf.connect(companyId, { apiToken: "cf-token-XYZ" }, boardActor);

    expect(conn.status).toBe("active");
    expect(conn.cfAccountId).toBe("acct1");

    // The raw token is stored as a company secret, not as a column on the row.
    const tokenSecret = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, companyId))
      .then((rows) => rows.find((r) => r.name === "CLOUDFLARE_API_TOKEN"));
    expect(tokenSecret).toBeTruthy();
    const [row] = await db
      .select()
      .from(cloudflareConnections)
      .where(eq(cloudflareConnections.companyId, companyId));
    expect(row.apiTokenSecretId).toBe(tokenSecret!.id);
    expect(JSON.stringify(conn)).not.toContain("cf-token-XYZ");
  });

  it("lists attachable zones from the connected account", async () => {
    const companyId = await seedCompany();
    await cf.connect(companyId, { apiToken: "cf-token-XYZ" }, boardActor);
    const zones = await cf.listZones(companyId);
    expect(zones).toEqual([{ id: "zone1", name: "example.com", status: "active" }]);
  });

  it("attaches a domain: generates DKIM, publishes DNS, stores the private key as a secret", async () => {
    const companyId = await seedCompany();
    await cf.connect(companyId, { apiToken: "cf-token-XYZ" }, boardActor);

    const domain = await mail.attach(companyId, "example.com", boardActor);

    expect(domain.domain).toBe("example.com");
    expect(domain.cfZoneId).toBe("zone1");
    expect(domain.dkimSelector).toBe("atl1");
    expect(domain.dkimPublicKey).toBeTruthy();
    // MAIL_HOSTNAME is set, so MX + SPF + DKIM + DMARC all publish -> active.
    expect(domain.mxConfigured).toBe(true);
    expect(domain.spfConfigured).toBe(true);
    expect(domain.dmarcConfigured).toBe(true);
    expect(domain.status).toBe("active");

    // DKIM private key is stored as a company secret, and never exposed in the projection.
    const dkimSecret = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, companyId))
      .then((rows) => rows.find((r) => r.name === "mail-dkim:example.com"));
    expect(dkimSecret).toBeTruthy();
    const [dbRow] = await db.select().from(mailDomains).where(eq(mailDomains.companyId, companyId));
    expect(dbRow.dkimPrivateKeySecretId).toBe(dkimSecret!.id);
    expect(JSON.stringify(domain)).not.toContain("PRIVATE KEY");

    // Re-attaching is idempotent (unique on company+domain) and reuses the DKIM key.
    const again = await mail.attach(companyId, "example.com", boardActor);
    expect(again.id).toBe(domain.id);
    expect(again.dkimPublicKey).toBe(domain.dkimPublicKey);
    const all = await mail.list(companyId);
    expect(all).toHaveLength(1);
  });

  it("OAuth: start builds a PKCE authorize URL, complete stores tokens + an oauth connection", async () => {
    const companyId = await seedCompany();
    expect(cf.isOAuthConfigured()).toBe(true);

    const { authorizeUrl } = cf.startOAuth(companyId, boardActor);
    const authUrl = new URL(authorizeUrl);
    expect(authUrl.origin + authUrl.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(authUrl.searchParams.get("client_id")).toBe("client-abc");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
    const state = authUrl.searchParams.get("state")!;
    expect(state).toBeTruthy();

    const { connection, issuePrefix } = await cf.completeOAuth(state, "auth-code-1");
    expect(connection.authType).toBe("oauth");
    expect(connection.status).toBe("active");
    expect(connection.cfAccountId).toBe("acct1");
    expect(issuePrefix).toBeTruthy();
    expect(JSON.stringify(connection)).not.toContain("cf-access-1");

    // Access + refresh tokens are stored as company secrets.
    const secretNames = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, companyId))
      .then((rows) => rows.map((r) => r.name));
    expect(secretNames).toContain("CLOUDFLARE_API_TOKEN");
    expect(secretNames).toContain("CLOUDFLARE_OAUTH_REFRESH_TOKEN");

    // The state is single-use: replaying it fails.
    await expect(cf.completeOAuth(state, "auth-code-1")).rejects.toThrow();
  });

  it("OAuth: getToken refreshes an expired access token", async () => {
    const companyId = await seedCompany();
    const { authorizeUrl } = cf.startOAuth(companyId, boardActor);
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    await cf.completeOAuth(state, "auth-code-1");

    // Force the access token to look expired.
    await db
      .update(cloudflareConnections)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(cloudflareConnections.companyId, companyId));

    // getToken should hit the token endpoint (refresh) and return the new access token.
    const token = await cf.getToken(companyId);
    expect(token).toBe("cf-access-1");
    const [row] = await db
      .select()
      .from(cloudflareConnections)
      .where(eq(cloudflareConnections.companyId, companyId));
    expect(row.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
