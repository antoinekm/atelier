import { describe, expect, it } from "vitest";
import { renderCapabilityRequestGuide } from "../services/capability-requests.ts";

describe("renderCapabilityRequestGuide (issue #2)", () => {
  it("documents the approvals endpoint and the three request types with the company id baked in", () => {
    const guide = renderCapabilityRequestGuide("company-123");
    expect(guide).toContain("/api/companies/company-123/approvals");
    expect(guide).toContain("$PAPERCLIP_API_KEY");
    expect(guide).toContain("request_mcp_install");
    expect(guide).toContain("request_skill_install");
    expect(guide).toContain("request_plugin_install");
    expect(guide).toContain("request_credential");
    // secrets-by-name discipline is surfaced
    expect(guide).toContain("secretName");
  });

  it("tells the agent it fully owns its domains and must not escalate domain/business decisions", () => {
    const guide = renderCapabilityRequestGuide("company-123");
    expect(guide).toContain("FULLY OWN");
    expect(guide).toMatch(/NEVER escalate a domain/i);
  });
});
