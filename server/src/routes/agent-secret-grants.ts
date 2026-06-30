import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Lead-managed secret grants. Granting an existing company secret to a sub-agent goes
 * through a human-approved `request_secret_grant` approval (see approvals.ts). Revoking is
 * lower risk (it only removes access), so the company lead can do it directly here without
 * board approval. Board callers are also allowed.
 */
export function agentSecretGrantRoutes(db: Db) {
  const router = Router();
  const agentsSvc = agentService(db);

  function isSecretRef(value: unknown): value is { type: "secret_ref"; secretId: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "secret_ref"
    );
  }

  // Revoke a previously granted secret from a sub-agent: unbind it from the agent's run
  // env. agentsSvc.update syncs company_secret_bindings, so the binding row is removed too.
  router.delete("/agents/:targetAgentId/granted-secrets/:envKey", async (req, res) => {
    const targetAgentId = req.params.targetAgentId as string;
    const envKey = req.params.envKey as string;

    const target = await agentsSvc.getById(targetAgentId);
    if (!target) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, target.companyId);

    // Authority: an agent caller must be the company lead, and the target must be a
    // different agent in its company. Board callers are allowed.
    if (req.actor.type === "agent") {
      const caller = req.actor.agentId ? await agentsSvc.getById(req.actor.agentId) : null;
      if (!caller || caller.reportsTo) {
        res.status(403).json({ error: "Only the company lead (CEO) can revoke a granted secret." });
        return;
      }
      if (caller.companyId !== target.companyId || caller.id === target.id) {
        res.status(403).json({ error: "You can only revoke secrets from your sub-agents." });
        return;
      }
    }

    const adapterConfig =
      typeof target.adapterConfig === "object" && target.adapterConfig !== null
        ? { ...(target.adapterConfig as Record<string, unknown>) }
        : {};
    const env =
      typeof adapterConfig.env === "object" && adapterConfig.env !== null
        ? { ...(adapterConfig.env as Record<string, unknown>) }
        : {};
    if (!isSecretRef(env[envKey])) {
      res.status(404).json({ error: `No granted secret at ${envKey} on this agent.` });
      return;
    }
    delete env[envKey];
    adapterConfig.env = env;
    await agentsSvc.update(targetAgentId, { adapterConfig });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: target.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "agent_secret_revoked",
      entityType: "agent",
      entityId: targetAgentId,
      details: { envKey },
    });

    res.json({ ok: true, envKey });
  });

  return router;
}
