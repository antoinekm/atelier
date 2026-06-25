/** The domain part of an email address, lowercased. */
export function domainOf(sender: string): string {
  return (sender.split("@")[1] ?? "").trim().toLowerCase();
}

/** Whether a sender matches a typed block entry (exact address, or domain + subdomains). */
export function senderMatches(sender: string, kind: "address" | "domain", value: string): boolean {
  const s = sender.trim().toLowerCase();
  const v = value.trim().toLowerCase();
  if (kind === "address") return s === v;
  const domain = domainOf(s);
  return domain === v || domain.endsWith(`.${v}`);
}

/**
 * Whether a sender matches an untyped list entry (operator env lists): an entry
 * containing "@" is an exact address, otherwise a domain (incl. subdomains).
 */
export function senderMatchesEntry(sender: string, entry: string): boolean {
  return senderMatches(sender, entry.includes("@") ? "address" : "domain", entry);
}
