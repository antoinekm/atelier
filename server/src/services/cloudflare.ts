import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { cloudflareConnections, companies } from "@paperclipai/db";
import type { CloudflareConnection, CloudflareZone } from "@paperclipai/shared";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

const CF_API = "https://api.cloudflare.com/client/v4";

/** Name of the company_secret that holds a connection's Cloudflare access/API token. */
const CF_TOKEN_SECRET_NAME = "CLOUDFLARE_API_TOKEN";
/** Name of the company_secret that holds the OAuth refresh token. */
const CF_REFRESH_SECRET_NAME = "CLOUDFLARE_OAUTH_REFRESH_TOKEN";

// ─── OAuth (self-managed OAuth clients, "Connect with Cloudflare") ────────────

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Instance-level OAuth app config (one Cloudflare OAuth client for the deployment). */
function oauthConfig() {
  const trim = (v?: string) => v?.trim() || "";
  const publicUrl = trim(process.env.PAPERCLIP_PUBLIC_URL).replace(/\/$/, "");
  return {
    clientId: trim(process.env.CLOUDFLARE_OAUTH_CLIENT_ID),
    clientSecret: trim(process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET),
    scopes: trim(process.env.CLOUDFLARE_OAUTH_SCOPES).split(/\s+/).filter(Boolean),
    authorizeEndpoint: trim(process.env.CLOUDFLARE_OAUTH_AUTHORIZE_URL) || "https://dash.cloudflare.com/oauth2/auth",
    tokenEndpoint: trim(process.env.CLOUDFLARE_OAUTH_TOKEN_URL) || "https://dash.cloudflare.com/oauth2/token",
    redirectUri:
      trim(process.env.CLOUDFLARE_OAUTH_REDIRECT_URI) ||
      (publicUrl ? `${publicUrl}/api/integrations/cloudflare/oauth/callback` : ""),
  };
}

function oauthConfigured(): boolean {
  const c = oauthConfig();
  return Boolean(c.clientId && c.clientSecret && c.redirectUri && c.scopes.length);
}

type OAuthPending = { companyId: string; actorType: "user" | "agent"; actorId: string; verifier: string; createdAt: number };
const oauthStates = new Map<string, OAuthPending>();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function rememberState(state: string, pending: OAuthPending): void {
  const now = Date.now();
  for (const [k, v] of oauthStates) if (now - v.createdAt > OAUTH_STATE_TTL_MS) oauthStates.delete(k);
  oauthStates.set(state, pending);
}
function consumeState(state: string): OAuthPending | null {
  const v = oauthStates.get(state);
  if (!v) return null;
  oauthStates.delete(state);
  if (Date.now() - v.createdAt > OAUTH_STATE_TTL_MS) return null;
  return v;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** POST to the Cloudflare OAuth token endpoint (auth-code exchange or refresh). */
async function postOAuthToken(form: Record<string, string>): Promise<OAuthTokenResponse> {
  const cfg = oauthConfig();
  const res = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => {
    throw unprocessable(`Cloudflare OAuth: ${err instanceof Error ? err.message : "token request failed"}`);
  });
  const json = (await res.json().catch(() => null)) as
    | (OAuthTokenResponse & { error?: string; error_description?: string })
    | null;
  if (!res.ok || !json?.access_token) {
    const msg = json?.error_description || json?.error || `token endpoint error (${res.status})`;
    throw unprocessable(`Cloudflare OAuth: ${msg}`);
  }
  return json;
}

export type CloudflareActor = { actorType: "user" | "agent"; actorId: string };

export interface CloudflareDnsRecord {
  type: "A" | "MX" | "TXT" | "CNAME";
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
}

type ConnectionRow = typeof cloudflareConnections.$inferSelect;

function toConnection(row: ConnectionRow): CloudflareConnection {
  return {
    id: row.id,
    companyId: row.companyId,
    cfAccountId: row.cfAccountId,
    authType: row.authType as CloudflareConnection["authType"],
    status: row.status as CloudflareConnection["status"],
    scopes: row.scopes ?? [],
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Minimal typed wrapper over the Cloudflare v4 REST API envelope. */
async function cfFetch<T = unknown>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  const url = new URL(`${CF_API}${path}`);
  for (const [k, v] of Object.entries(init?.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    // Don't let a hung Cloudflare request stall a request handler indefinitely.
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => {
    throw unprocessable(`Cloudflare: ${err instanceof Error ? err.message : "request failed"}`);
  });
  const json = (await res.json().catch(() => null)) as
    | { success?: boolean; result?: T; errors?: Array<{ message?: string }> }
    | null;
  if (!res.ok || !json?.success) {
    const message =
      json?.errors?.map((e) => e.message).filter(Boolean).join("; ") ||
      `Cloudflare API error (${res.status})`;
    throw unprocessable(`Cloudflare: ${message}`);
  }
  return json.result as T;
}

export function cloudflareService(db: Db) {
  const secrets = secretService(db);

  async function getRow(companyId: string): Promise<ConnectionRow | null> {
    return db
      .select()
      .from(cloudflareConnections)
      .where(eq(cloudflareConnections.companyId, companyId))
      .then((rows) => rows[0] ?? null);
  }

  /** Create a named company secret, or rotate it to a new value if it exists. */
  async function upsertSecret(
    companyId: string,
    name: string,
    value: string,
    actorRef: { userId: string | null; agentId: string | null },
  ): Promise<string> {
    const existing = await secrets.getByName(companyId, name);
    if (existing) {
      await secrets.rotate(existing.id, { value }, actorRef);
      return existing.id;
    }
    const created = await secrets.create(companyId, { name, provider: "local_encrypted", value }, actorRef);
    return created.id;
  }

  async function resolveSecret(companyId: string, secretId: string): Promise<string> {
    const resolved = await secrets.resolveEnvBindings(companyId, {
      [CF_TOKEN_SECRET_NAME]: { type: "secret_ref", secretId, version: "latest" },
    });
    return resolved.env[CF_TOKEN_SECRET_NAME] ?? "";
  }

  /**
   * Resolve the plaintext access token for a company's connection. For OAuth
   * connections, refresh the access token first if it is expired (or about to).
   */
  async function getToken(companyId: string): Promise<string> {
    const row = await getRow(companyId);
    if (!row) throw notFound("No Cloudflare connection for this company");

    const needsRefresh =
      row.authType === "oauth" &&
      row.refreshTokenSecretId != null &&
      row.accessTokenExpiresAt != null &&
      row.accessTokenExpiresAt.getTime() - Date.now() < 60_000;

    if (needsRefresh) {
      const cfg = oauthConfig();
      const refreshToken = await resolveSecret(companyId, row.refreshTokenSecretId as string);
      if (!refreshToken) throw unprocessable("Cloudflare refresh token could not be resolved");
      const tokens = await postOAuthToken({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      });
      await secrets.rotate(row.apiTokenSecretId, { value: tokens.access_token }, {});
      if (tokens.refresh_token && row.refreshTokenSecretId) {
        await secrets.rotate(row.refreshTokenSecretId, { value: tokens.refresh_token }, {});
      }
      await db
        .update(cloudflareConnections)
        .set({
          accessTokenExpiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
          updatedAt: new Date(),
        })
        .where(eq(cloudflareConnections.id, row.id));
      return tokens.access_token;
    }

    const token = await resolveSecret(companyId, row.apiTokenSecretId);
    if (!token) throw unprocessable("Cloudflare token could not be resolved");
    return token;
  }

  return {
    get: async (companyId: string): Promise<CloudflareConnection | null> => {
      const row = await getRow(companyId);
      return row ? toConnection(row) : null;
    },

    getToken,

    /**
     * Connect (or replace) a company's Cloudflare account. The token is verified
     * against the Cloudflare API, stored as a company secret, and the connection
     * row is upserted. The raw token never persists on the connection row.
     */
    connect: async (
      companyId: string,
      input: { apiToken: string; cfAccountId?: string },
      actor: CloudflareActor,
    ): Promise<CloudflareConnection> => {
      const actorRef = {
        userId: actor.actorType === "user" ? actor.actorId : null,
        agentId: actor.actorType === "agent" ? actor.actorId : null,
      };

      // 1. Verify the token works before storing anything.
      const verify = await cfFetch<{ id: string; status: string }>(input.apiToken, "/user/tokens/verify");
      if (verify.status !== "active") {
        throw unprocessable(`Cloudflare token is not active (status: ${verify.status})`);
      }

      // 2. Resolve an account id if not supplied.
      let accountId = input.cfAccountId ?? null;
      if (!accountId) {
        const accounts = await cfFetch<Array<{ id: string; name: string }>>(input.apiToken, "/accounts", {
          query: { "per_page": "1" },
        });
        accountId = accounts[0]?.id ?? null;
      }

      // 3. Store the token as a company secret (create or rotate).
      const existingSecret = await secrets.getByName(companyId, CF_TOKEN_SECRET_NAME);
      let secretId: string;
      if (existingSecret) {
        await secrets.rotate(existingSecret.id, { value: input.apiToken }, actorRef);
        secretId = existingSecret.id;
      } else {
        const created = await secrets.create(
          companyId,
          { name: CF_TOKEN_SECRET_NAME, provider: "local_encrypted", value: input.apiToken },
          actorRef,
        );
        secretId = created.id;
      }

      // 4. Upsert the connection row.
      const now = new Date();
      const existing = await getRow(companyId);
      let row: ConnectionRow;
      if (existing) {
        row = await db
          .update(cloudflareConnections)
          .set({
            cfAccountId: accountId,
            apiTokenSecretId: secretId,
            status: "active",
            verifiedAt: now,
            updatedAt: now,
          })
          .where(eq(cloudflareConnections.id, existing.id))
          .returning()
          .then((rows) => rows[0]);
      } else {
        row = await db
          .insert(cloudflareConnections)
          .values({
            companyId,
            cfAccountId: accountId,
            apiTokenSecretId: secretId,
            status: "active",
            verifiedAt: now,
            createdByAgentId: actorRef.agentId,
            createdByUserId: actorRef.userId,
          })
          .returning()
          .then((rows) => rows[0]);
      }
      return toConnection(row);
    },

    disconnect: async (companyId: string): Promise<void> => {
      const row = await getRow(companyId);
      if (!row) return;
      await db.delete(cloudflareConnections).where(eq(cloudflareConnections.id, row.id));
      // Best-effort cleanup of the stored token secrets so they don't linger.
      await secrets.remove(row.apiTokenSecretId).catch(() => {});
      if (row.refreshTokenSecretId) await secrets.remove(row.refreshTokenSecretId).catch(() => {});
    },

    /** Whether this instance has a Cloudflare OAuth app configured. */
    isOAuthConfigured: (): boolean => oauthConfigured(),

    /**
     * Begin the OAuth "Connect with Cloudflare" flow: generate PKCE + state,
     * remember them server-side, and return the authorize URL to redirect to.
     */
    startOAuth: (companyId: string, actor: CloudflareActor): { authorizeUrl: string } => {
      const cfg = oauthConfig();
      if (!oauthConfigured()) throw unprocessable("Cloudflare OAuth is not configured on this instance");
      const verifier = base64url(randomBytes(32));
      const challenge = base64url(createHash("sha256").update(verifier).digest());
      const state = base64url(randomBytes(24));
      rememberState(state, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        verifier,
        createdAt: Date.now(),
      });
      const url = new URL(cfg.authorizeEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", cfg.clientId);
      url.searchParams.set("redirect_uri", cfg.redirectUri);
      url.searchParams.set("scope", cfg.scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return { authorizeUrl: url.toString() };
    },

    /** Look up a pending OAuth flow's company by state (without consuming it). */
    peekOAuthState: (state: string): { companyId: string } | null => {
      const v = oauthStates.get(state);
      return v ? { companyId: v.companyId } : null;
    },

    /**
     * Complete the OAuth flow: exchange the code for tokens, store them as
     * company secrets, and upsert the connection. Returns the company + its issue
     * prefix so the caller can redirect back to the right settings page.
     */
    completeOAuth: async (
      state: string,
      code: string,
    ): Promise<{ companyId: string; issuePrefix: string; connection: CloudflareConnection }> => {
      const pending = consumeState(state);
      if (!pending) throw badRequest("Invalid or expired OAuth state");
      const cfg = oauthConfig();
      const tokens = await postOAuthToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: cfg.redirectUri,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code_verifier: pending.verifier,
      });
      const companyId = pending.companyId;
      const actorRef = {
        userId: pending.actorType === "user" ? pending.actorId : null,
        agentId: pending.actorType === "agent" ? pending.actorId : null,
      };

      let accountId: string | null = null;
      try {
        const accounts = await cfFetch<Array<{ id: string }>>(tokens.access_token, "/accounts", { query: { per_page: "1" } });
        accountId = accounts[0]?.id ?? null;
      } catch {
        accountId = null;
      }

      const accessSecretId = await upsertSecret(companyId, CF_TOKEN_SECRET_NAME, tokens.access_token, actorRef);
      const refreshSecretId = tokens.refresh_token
        ? await upsertSecret(companyId, CF_REFRESH_SECRET_NAME, tokens.refresh_token, actorRef)
        : null;

      const now = new Date();
      const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
      const scopes = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : cfg.scopes;
      const existing = await getRow(companyId);
      let row: ConnectionRow;
      if (existing) {
        row = await db
          .update(cloudflareConnections)
          .set({
            cfAccountId: accountId,
            authType: "oauth",
            apiTokenSecretId: accessSecretId,
            refreshTokenSecretId: refreshSecretId,
            accessTokenExpiresAt: expiresAt,
            status: "active",
            scopes,
            verifiedAt: now,
            updatedAt: now,
          })
          .where(eq(cloudflareConnections.id, existing.id))
          .returning()
          .then((r) => r[0]);
      } else {
        row = await db
          .insert(cloudflareConnections)
          .values({
            companyId,
            cfAccountId: accountId,
            authType: "oauth",
            apiTokenSecretId: accessSecretId,
            refreshTokenSecretId: refreshSecretId,
            accessTokenExpiresAt: expiresAt,
            status: "active",
            scopes,
            createdByAgentId: actorRef.agentId,
            createdByUserId: actorRef.userId,
            verifiedAt: now,
          })
          .returning()
          .then((r) => r[0]);
      }
      const company = await db
        .select({ issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((r) => r[0]);
      return { companyId, issuePrefix: company?.issuePrefix ?? "", connection: toConnection(row) };
    },

    /** List the zones (domains) the connected account can manage (all pages). */
    listZones: async (companyId: string): Promise<CloudflareZone[]> => {
      const token = await getToken(companyId);
      const perPage = 50;
      const out: CloudflareZone[] = [];
      for (let page = 1; page <= 20; page++) {
        const zones = await cfFetch<Array<{ id: string; name: string; status: string }>>(token, "/zones", {
          query: { per_page: String(perPage), page: String(page) },
        });
        out.push(...zones.map((z) => ({ id: z.id, name: z.name, status: z.status })));
        if (zones.length < perPage) break;
      }
      return out;
    },

    /** Resolve a zone id for a domain name owned by the connected account. */
    getZoneId: async (companyId: string, domain: string): Promise<string> => {
      const token = await getToken(companyId);
      const zones = await cfFetch<Array<{ id: string; name: string }>>(token, "/zones", {
        query: { name: domain },
      });
      const zone = zones[0];
      if (!zone) throw badRequest(`Domain "${domain}" is not a zone in the connected Cloudflare account`);
      return zone.id;
    },

    /**
     * Create or update a single DNS record (idempotent on type+name). Used to
     * publish the mail records (MX/SPF/DKIM/DMARC) on an attached zone.
     */
    upsertDnsRecord: async (
      companyId: string,
      zoneId: string,
      record: CloudflareDnsRecord,
    ): Promise<void> => {
      const token = await getToken(companyId);
      const existing = await cfFetch<Array<{ id: string }>>(token, `/zones/${zoneId}/dns_records`, {
        query: { type: record.type, name: record.name },
      });
      const body: Record<string, unknown> = {
        type: record.type,
        name: record.name,
        content: record.content,
        ttl: record.ttl ?? 1,
      };
      if (record.priority !== undefined) body.priority = record.priority;
      if (existing[0]) {
        await cfFetch(token, `/zones/${zoneId}/dns_records/${existing[0].id}`, { method: "PUT", body });
      } else {
        await cfFetch(token, `/zones/${zoneId}/dns_records`, { method: "POST", body });
      }
    },
  };
}
