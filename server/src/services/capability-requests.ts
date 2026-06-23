/**
 * Always-on run-context guide (issue #2) telling an agent it can request new
 * capabilities for itself when blocked. claude_local agents talk to the control
 * plane over the REST API (not an MCP tool), so this documents the approvals
 * endpoint and bakes in the agent's companyId. Mirrors the long-term-memory
 * write guide: without it the request path exists but agents never discover it.
 */
export function renderCapabilityRequestGuide(companyId: string): string {
  return [
    "Requesting new capabilities for yourself:",
    "When a missing tool, skill, or plugin blocks you, request it instead of giving up. The board reviews and approves; on approval you are woken and the capability is available. Use your usual API access:",
    `  POST $PAPERCLIP_API_URL/api/companies/${companyId}/approvals  (header: Authorization: Bearer $PAPERCLIP_API_KEY)`,
    "with one of these JSON bodies:",
    '- Tool / MCP server (e.g. a browser, an integration): {"type":"request_mcp_install","payload":{"name":"<slug>","transport":"http"|"stdio","url":"<https url for http>","command":"<cmd for stdio>","args":["..."],"reason":"<why>","env":[{"key":"TOKEN","secretName":"<secret-name>"}]}}',
    '- Skill (a how-to from the catalog): {"type":"request_skill_install","payload":{"catalogSkillId":"<id>","reason":"<why>"}}',
    '- Plugin (server-side, instance-wide; an instance admin must approve): {"type":"request_plugin_install","payload":{"packageName":"<pkg>","version":"<optional>","reason":"<why>"}}',
    "Declare any secret by NAME only (never paste secret values); the board supplies them. Prefer http-transport MCP servers (no local browser/binary to install in your sandbox).",
  ].join("\n");
}
