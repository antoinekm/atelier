import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { connectCloudflareSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { cloudflareService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Cloudflare account connection for embedded mail (phase 0). Board-only: a human
 * connects an API token so the platform can read zones and publish mail DNS.
 */
export function cloudflareIntegrationRoutes(db: Db) {
  const router = Router();
  const svc = cloudflareService(db);

  // Current connection (without the token) + whether one-click OAuth is available.
  router.get("/companies/:companyId/integrations/cloudflare", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json({ connection: await svc.get(companyId), oauthAvailable: svc.isOAuthConfigured() });
  });

  // Begin the one-click "Connect with Cloudflare" OAuth flow: returns the URL the
  // browser should navigate to.
  router.get("/companies/:companyId/integrations/cloudflare/oauth/start", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const info = getActorInfo(req);
    res.json(svc.startOAuth(companyId, { actorType: info.actorType, actorId: info.actorId }));
  });

  // OAuth redirect callback (Cloudflare sends the browser here). Validates state,
  // exchanges the code, stores the tokens, then redirects back to settings.
  router.get("/integrations/cloudflare/oauth/callback", async (req, res) => {
    const publicUrl = (process.env.PAPERCLIP_PUBLIC_URL ?? "").trim().replace(/\/$/, "");
    const settingsUrl = (prefix: string, query: string) =>
      `${publicUrl}/${prefix}/company/settings/mail${query}`;
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const oauthError = typeof req.query.error === "string" ? req.query.error : "";

    const pending = state ? svc.peekOAuthState(state) : null;
    if (!pending) {
      res.redirect(`${publicUrl}/?cloudflare_error=invalid_state`);
      return;
    }
    assertCompanyAccess(req, pending.companyId);

    if (oauthError || !code) {
      res.redirect(`${publicUrl}/?cloudflare_error=${encodeURIComponent(oauthError || "no_code")}`);
      return;
    }

    const result = await svc.completeOAuth(state, code);
    await logActivity(db, {
      companyId: result.companyId,
      actorType: "user",
      actorId: getActorInfo(req).actorId,
      action: "cloudflare_connected",
      entityType: "cloudflare_connection",
      entityId: result.connection.id,
      details: { cfAccountId: result.connection.cfAccountId, authType: "oauth" },
    });
    res.redirect(settingsUrl(result.issuePrefix, "?cloudflare=connected"));
  });

  // Connect (or replace) the Cloudflare account.
  router.post(
    "/companies/:companyId/integrations/cloudflare",
    validate(connectCloudflareSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const info = getActorInfo(req);
      const connection = await svc.connect(companyId, req.body, {
        actorType: info.actorType,
        actorId: info.actorId,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: info.actorId,
        action: "cloudflare_connected",
        entityType: "cloudflare_connection",
        entityId: connection.id,
        details: { cfAccountId: connection.cfAccountId },
      });
      res.status(201).json(connection);
    },
  );

  // Disconnect.
  router.delete("/companies/:companyId/integrations/cloudflare", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const existing = await svc.get(companyId);
    await svc.disconnect(companyId);
    if (existing) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: getActorInfo(req).actorId,
        action: "cloudflare_disconnected",
        entityType: "cloudflare_connection",
        entityId: existing.id,
        details: { cfAccountId: existing.cfAccountId },
      });
    }
    res.status(204).end();
  });

  // List the zones (domains) the connected account can manage.
  router.get("/companies/:companyId/integrations/cloudflare/zones", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(await svc.listZones(companyId));
  });

  return router;
}
