import { describe, expect, it } from "vitest";
import { isMailManagedDnsRecord } from "../services/cloudflare.ts";

const domain = { domain: "victoire.run", dkimSelector: "atl1" };

describe("isMailManagedDnsRecord (protect mail records from the generic DNS API)", () => {
  it("flags the mail-managed records", () => {
    expect(isMailManagedDnsRecord({ type: "MX", name: "victoire.run", content: "mail.x" }, domain)).toBe(true);
    expect(
      isMailManagedDnsRecord({ type: "TXT", name: "atl1._domainkey.victoire.run", content: "v=DKIM1; ..." }, domain),
    ).toBe(true);
    expect(isMailManagedDnsRecord({ type: "TXT", name: "_dmarc.victoire.run", content: "v=DMARC1" }, domain)).toBe(true);
    expect(isMailManagedDnsRecord({ type: "TXT", name: "victoire.run", content: "v=spf1 ip4:1.2.3.4 ~all" }, domain)).toBe(true);
    // Case/trailing-dot insensitive.
    expect(isMailManagedDnsRecord({ type: "mx", name: "Victoire.run.", content: "mail" }, domain)).toBe(true);
  });

  it("allows ordinary subdomain records", () => {
    expect(
      isMailManagedDnsRecord({ type: "CNAME", name: "tools.victoire.run", content: "x.netlify.app" }, domain),
    ).toBe(false);
    expect(isMailManagedDnsRecord({ type: "A", name: "app.victoire.run", content: "1.2.3.4" }, domain)).toBe(false);
    // A non-SPF TXT at the apex (e.g. a site-verification token) is allowed.
    expect(isMailManagedDnsRecord({ type: "TXT", name: "victoire.run", content: "google-site-verification=abc" }, domain)).toBe(false);
    // MX on a subdomain is not the apex mail record.
    expect(isMailManagedDnsRecord({ type: "MX", name: "sub.victoire.run", content: "mail" }, domain)).toBe(false);
  });
});
