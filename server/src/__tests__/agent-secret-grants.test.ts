import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({ getById: vi.fn(), update: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    logActivity: mockLogActivity,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { agentSecretGrantRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/agent-secret-grants.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentSecretGrantRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const leadActor = {
  type: "agent",
  agentId: "ceo-1",
  companyId: "company-1",
  source: "api_key",
  isInstanceAdmin: false,
};
const subActor = {
  type: "agent",
  agentId: "cto-1",
  companyId: "company-1",
  source: "api_key",
  isInstanceAdmin: false,
};

describe("agent secret grant revoke", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("lets the company lead revoke a granted secret from a sub-agent", async () => {
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "cto-1")
        return {
          id: "cto-1",
          companyId: "company-1",
          reportsTo: "ceo-1",
          adapterConfig: { env: { GITHUB_TOKEN: { type: "secret_ref", secretId: "s1", version: "latest" } } },
        };
      if (id === "ceo-1") return { id: "ceo-1", companyId: "company-1", reportsTo: null };
      return null;
    });
    mockAgentService.update.mockResolvedValue({});

    const res = await request(await createApp(leadActor)).delete(
      "/api/agents/cto-1/granted-secrets/GITHUB_TOKEN",
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "cto-1",
      expect.objectContaining({ adapterConfig: expect.objectContaining({ env: {} }) }),
    );
  });

  it("blocks a reporting agent from revoking", async () => {
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "cto-1")
        return {
          id: "cto-1",
          companyId: "company-1",
          reportsTo: "ceo-1",
          adapterConfig: { env: { GITHUB_TOKEN: { type: "secret_ref", secretId: "s1" } } },
        };
      return null;
    });

    const res = await request(await createApp(subActor)).delete(
      "/api/agents/cto-1/granted-secrets/GITHUB_TOKEN",
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("returns 404 when the env key has no granted secret", async () => {
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "cto-1") return { id: "cto-1", companyId: "company-1", reportsTo: "ceo-1", adapterConfig: { env: {} } };
      if (id === "ceo-1") return { id: "ceo-1", companyId: "company-1", reportsTo: null };
      return null;
    });

    const res = await request(await createApp(leadActor)).delete(
      "/api/agents/cto-1/granted-secrets/MISSING",
    );

    expect(res.status).toBe(404);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});
