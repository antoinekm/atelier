/**
 * Inbound mail abuse controls for the embedded SMTP listener: an operator
 * allow/deny list and a per-sender sliding-window rate limit. All configured via
 * env so an operator can tighten reception without a schema/UI change:
 *
 * - MAIL_SENDER_DENYLIST: comma-separated emails or domains to reject (550).
 * - MAIL_SENDER_ALLOWLIST: if set, ONLY these senders are accepted (others 550).
 * - MAIL_INBOUND_RATE_PER_MIN: max accepted messages per sender per minute (421).
 *
 * Entries match an exact email (contains "@") or a domain (matches the sender's
 * domain and its subdomains).
 */
export interface InboundGuardDecision {
  ok: boolean;
  smtpError?: string;
}

const WINDOW_MS = 60_000;

function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function matches(sender: string, entry: string): boolean {
  const domain = sender.split("@")[1] ?? "";
  if (entry.includes("@")) return sender === entry;
  return domain === entry || domain.endsWith(`.${entry}`);
}

export function createInboundGuard(now: () => number = () => Date.now()) {
  const denylist = parseList(process.env.MAIL_SENDER_DENYLIST);
  const allowlist = parseList(process.env.MAIL_SENDER_ALLOWLIST);
  const ratePerMin = Math.max(0, Number(process.env.MAIL_INBOUND_RATE_PER_MIN ?? 30));
  const hits = new Map<string, number[]>();

  return {
    /** Decide whether to accept mail from this envelope sender. */
    check(senderRaw: string | undefined): InboundGuardDecision {
      const sender = (senderRaw ?? "").trim().toLowerCase();

      if (denylist.some((e) => matches(sender, e))) {
        return { ok: false, smtpError: "550 5.7.1 Sender not allowed" };
      }
      if (allowlist.length > 0 && !allowlist.some((e) => matches(sender, e))) {
        return { ok: false, smtpError: "550 5.7.1 Sender not allowed" };
      }

      if (ratePerMin > 0 && sender) {
        const current = now();
        const cutoff = current - WINDOW_MS;
        const recent = (hits.get(sender) ?? []).filter((t) => t > cutoff);
        if (recent.length >= ratePerMin) {
          return { ok: false, smtpError: "421 4.7.0 Too many messages, try again later" };
        }
        recent.push(current);
        hits.set(sender, recent);
      }
      return { ok: true };
    },
  };
}

export type InboundGuard = ReturnType<typeof createInboundGuard>;
