import { Resolver } from "node:dns/promises";
import type { MailReverseDnsStatus } from "@paperclipai/shared";

const CACHE_TTL_MS = 60_000;

// Query public resolvers so the check reflects what external mail servers (Gmail,
// Yahoo, etc.) see, not the local/Docker caching resolver, which can lag behind a
// PTR change for the full record TTL (OVH publishes PTRs with a 24h TTL). Bounded
// timeout/tries so "Recheck" fails fast instead of hanging the request. Falls back
// to the system resolver if the public ones are unreachable from this host.
const PUBLIC_DNS = ["1.1.1.1", "8.8.8.8"];

function makeResolver(servers?: string[]): Resolver {
  const r = new Resolver({ timeout: 3000, tries: 1 });
  if (servers) r.setServers(servers);
  return r;
}

const publicResolver = makeResolver(PUBLIC_DNS);
const systemResolver = makeResolver();

// Only fall back to the system resolver when the public one was unreachable or
// failed to answer, never on an authoritative "no record" (NXDOMAIN/ENODATA):
// falling back there would reintroduce the stale local-cache results we want to
// avoid. A no-record error propagates and is read as "missing" by the caller.
const FALLBACK_CODES = new Set([
  "ETIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ESERVFAIL",
  "EREFUSED",
  "ECANCELLED",
  "ENOTIMP",
  "EBADRESP",
]);

function shouldFallback(err: unknown): boolean {
  return err instanceof Error && FALLBACK_CODES.has((err as NodeJS.ErrnoException).code ?? "");
}

async function resolve4(host: string): Promise<string[]> {
  try {
    return await publicResolver.resolve4(host);
  } catch (err) {
    if (shouldFallback(err)) return systemResolver.resolve4(host);
    throw err;
  }
}

async function reverse(ip: string): Promise<string[]> {
  try {
    return await publicResolver.reverse(ip);
  } catch (err) {
    if (shouldFallback(err)) return systemResolver.reverse(ip);
    throw err;
  }
}

// Reverse DNS is instance-level (one sending IP for the whole deployment), so the
// result is the same for every company; a single in-process cache is enough.
let cache: { status: MailReverseDnsStatus; at: number } | null = null;

function env(name: string): string {
  return process.env[name]?.trim() || "";
}

/** The IP the mail engine sends from: explicit override, else the HELO host's A record. */
async function resolveSendingIp(hostname: string): Promise<string | null> {
  const override = env("MAIL_PUBLIC_IP");
  if (override) return override;
  const ips = await resolve4(hostname).catch(() => [] as string[]);
  return ips[0] ?? null;
}

async function compute(): Promise<MailReverseDnsStatus> {
  const checkedAt = new Date().toISOString();
  const hostname = env("MAIL_HOSTNAME") || null;
  const base = { hostname, ip: null, ptr: null, fcrdns: false, matchesHostname: false, checkedAt };

  if (!hostname) {
    return {
      ...base,
      status: "unconfigured",
      message:
        "Set MAIL_HOSTNAME on the server and attach a domain so the mail engine can announce itself.",
    };
  }

  const ip = await resolveSendingIp(hostname);
  if (!ip) {
    return {
      ...base,
      status: "error",
      message: `Could not resolve a sending IP for ${hostname}. Check its A record, or set MAIL_PUBLIC_IP.`,
    };
  }

  const ptrs = await reverse(ip).catch(() => [] as string[]);
  if (ptrs.length === 0) {
    return {
      ...base,
      ip,
      status: "missing",
      message: `${ip} has no reverse DNS. Set its PTR to ${hostname} in your host's manager (on OVH: VPS, then IP, then Reverse DNS).`,
    };
  }

  const want = hostname.replace(/\.$/, "").toLowerCase();
  const normalized = ptrs.map((p) => p.replace(/\.$/, "").toLowerCase());
  const matchesHostname = normalized.includes(want);
  const ptr = matchesHostname ? want : normalized[0];

  // FCrDNS: the PTR name must forward-resolve back to the same IP.
  const forward = await resolve4(ptr).catch(() => [] as string[]);
  const fcrdns = forward.includes(ip);

  if (matchesHostname && fcrdns) {
    return {
      ...base,
      ip,
      ptr,
      fcrdns: true,
      matchesHostname: true,
      status: "ok",
      message: `Reverse DNS is correct: ${ip} points to ${hostname} and forward-confirms.`,
    };
  }

  const reason = !matchesHostname
    ? `the PTR is ${ptr}, not ${hostname}`
    : `${hostname} does not resolve back to ${ip}`;
  return {
    ...base,
    ip,
    ptr,
    fcrdns,
    matchesHostname,
    status: "mismatch",
    message: `Reverse DNS does not match: ${reason}. Set the PTR of ${ip} to ${hostname} in your host's manager.`,
  };
}

/**
 * Reverse-DNS (PTR) health for the mail engine's sending IP. The PTR is owned by
 * the host provider (its `in-addr.arpa` zone), not Cloudflare, so it cannot be
 * published from Atelier; this only inspects and reports its state. Cached for a
 * minute to avoid hammering the resolver from the dashboard.
 */
export function mailDiagnosticsService() {
  return {
    getReverseDnsStatus: async (force = false): Promise<MailReverseDnsStatus> => {
      const now = Date.now();
      if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.status;
      const status = await compute();
      cache = { status, at: now };
      return status;
    },
  };
}
