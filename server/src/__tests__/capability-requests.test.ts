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

  it("tells a reporting agent to route credential needs through its CEO", () => {
    const guide = renderCapabilityRequestGuide("company-123", { isLead: false });
    expect(guide).toMatch(/ask your CEO/i);
    expect(guide).toMatch(/blocks request_credential from reporting agents/i);
  });

  it("tells the company lead it owns credentials and must avoid duplicate requests", () => {
    const guide = renderCapabilityRequestGuide("company-123", { isLead: true });
    expect(guide).toMatch(/own credential acquisition/i);
    expect(guide).toMatch(/one pending request per env key/i);
  });
});
