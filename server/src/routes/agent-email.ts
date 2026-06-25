import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import {
  attachDomainSchema,
  createDnsRecordSchema,
  createMailAddressSchema,
  createSenderBlockSchema,
  draftSchema,
  mailFlagSchema,
  mailInboxQuerySchema,
  mailListQuerySchema,
  sendEmailSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  agentService,
  cloudflareService,
  mailAddressService,
  mailDomainService,
  mailMessageService,
  mailOutboundGuard,
  mailSenderBlockService,
  logActivity,
} from "../services/index.js";
import { isMailManagedDnsRecord } from "../services/cloudflare.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import type { MailAddressActor } from "../services/mail-addresses.js";
import type { StorageService } from "../storage/types.js";
import {
  isInlineAttachmentContentType,
  normalizeContentType,
  MAX_ATTACHMENT_BYTES,
} from "../attachment-types.js";

type ParsedRange = { kind: "none" } | { kind: "invalid" } | { kind: "range"; start: number; end: number };

function parseRangeHeader(raw: string | undefined, contentLength: number): ParsedRange {
  if (!raw) return { kind: "none" };
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) return { kind: "invalid" };
  const prefix = "bytes=";
  if (!raw.toLowerCase().startsWith(prefix)) return { kind: "invalid" };
  const spec = raw.slice(prefix.length).trim();
  if (!spec || spec.includes(",")) return { kind: "invalid" };
  const [startRaw, endRaw] = spec.split("-", 2);
  if (endRaw === undefined) return { kind: "invalid" };
  if (startRaw === "") {
    const suffix = Number.parseInt(endRaw, 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: "invalid" };
    return { kind: "range", start: Math.max(contentLength - suffix, 0), end: contentLength - 1 };
  }
  const start = Number.parseInt(startRaw, 10);
  if (!Number.isSafeInteger(start) || start < 0 || start >= contentLength) return { kind: "invalid" };
  const end = endRaw === "" ? contentLength - 1 : Number.parseInt(endRaw, 10);
  if (!Number.isSafeInteger(end) || end < start) return { kind: "invalid" };
  return { kind: "range", start, end: Math.min(end, contentLength - 1) };
}

/**
 * Agent-facing email (embedded mail). An agent manages its own addresses and
 * mailbox; board members can also act for any agent in their company. This is
 * the API behind the per-agent mail client (mini Gmail).
 */
export function agentEmailRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const agents = agentService(db);
  const addresses = mailAddressService(db);
  const messages = mailMessageService(db);
  const domains = mailDomainService(db);
  const blocks = mailSenderBlockService(db);
  const cloudflare = cloudflareService(db);
  const outboundGuard = mailOutboundGuard(db);

  const attachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });
  async function runUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      attachmentUpload.single("file")(req, res, (err: unknown) => (err ? reject(err) : resolve()));
    });
  }

  async function resolveContext(
    req: Request,
    agentId: string,
  ): Promise<{ companyId: string; actor: MailAddressActor }> {
    const agent = await agents.getById(agentId);
    if (!agent) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    const info = getActorInfo(req);
    if (info.actorType === "agent" && info.agentId !== agentId) {
      throw forbidden("Agents can only access their own mailbox");
    }
    return { companyId: agent.companyId, actor: { actorType: info.actorType, actorId: info.actorId } };
  }

  // ─── Addresses ────────────────────────────────────────────────────────────

  router.get("/agents/:agentId/email/addresses", async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    res.json(await addresses.list(companyId, { agentId }));
  });

  router.post("/agents/:agentId/email/addresses", validate(createMailAddressSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId, actor } = await resolveContext(req, agentId);
    const address = await addresses.create(companyId, agentId, req.body, actor);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "mail_address_created",
      entityType: "mail_address",
      entityId: address.id,
      agentId,
      details: { address: address.address, kind: address.kind },
    });
    res.status(201).json(address);
  });

  router.delete("/agents/:agentId/email/addresses/:id", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const address = await addresses.getById(companyId, id);
    if (address.agentId !== agentId) throw forbidden("This address does not belong to the agent");
    await addresses.remove(companyId, id);
    res.status(204).end();
  });

  // ─── Mailbox: folders, list, threads, messages ────────────────────────────

  // Folder/search/paginated/threaded list (the mini-Gmail message list).
  router.get("/agents/:agentId/email/messages", async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    const parsed = mailListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw unprocessable("Invalid list query");
    res.json(await messages.listFolder(companyId, agentId, parsed.data));
  });

  // Unread counts per folder (for the rail badges).
  router.get("/agents/:agentId/email/folders", async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    res.json(await messages.folderCounts(companyId, agentId));
  });

  // A full conversation thread.
  router.get("/agents/:agentId/email/threads/:threadId", async (req, res) => {
    const agentId = req.params.agentId as string;
    const threadId = req.params.threadId as string;
    const { companyId } = await resolveContext(req, agentId);
    res.json(await messages.getThread(companyId, agentId, threadId));
  });

  // Legacy inbox listing (agent run-context API contract).
  router.get("/agents/:agentId/email/inbox", async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    const parsed = mailInboxQuerySchema.safeParse(req.query);
    if (!parsed.success) throw unprocessable("Invalid inbox query");
    res.json(await messages.listInbox(companyId, agentId, parsed.data));
  });

  // Fetch one message (with attachments).
  router.get("/agents/:agentId/email/messages/:id", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const message = await messages.getById(companyId, id);
    if (message.agentId !== agentId) throw forbidden("This message does not belong to the agent");
    res.json(message);
  });

  // ─── Flags / trash / restore / delete / retry ─────────────────────────────

  router.patch("/agents/:agentId/email/messages/:id/flags", validate(mailFlagSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const message = await messages.getById(companyId, id);
    if (message.agentId !== agentId) throw forbidden("This message does not belong to the agent");
    res.json(await messages.setFlags(companyId, id, req.body));
  });

  router.post("/agents/:agentId/email/messages/:id/trash", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const message = await messages.getById(companyId, id);
    if (message.agentId !== agentId) throw forbidden("This message does not belong to the agent");
    res.json(await messages.trash(companyId, id));
  });

  router.post("/agents/:agentId/email/messages/:id/restore", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const message = await messages.getById(companyId, id);
    if (message.agentId !== agentId) throw forbidden("This message does not belong to the agent");
    res.json(await messages.restore(companyId, id));
  });

  router.post("/agents/:agentId/email/messages/:id/retry", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const message = await messages.getById(companyId, id);
    if (message.agentId !== agentId) throw forbidden("This message does not belong to the agent");
    const queued = await messages.retry(companyId, id);
    res.status(202).json(queued);
  });

  router.delete("/agents/:agentId/email/messages/:id", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const message = await messages.getById(companyId, id);
    if (message.agentId !== agentId) throw forbidden("This message does not belong to the agent");
    const { objectKeys } = await messages.hardDelete(companyId, id);
    await Promise.all(objectKeys.map((key) => storage.deleteObject(companyId, key).catch(() => {})));
    res.status(204).end();
  });

  router.post("/agents/:agentId/email/messages/:id/read", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const message = await messages.getById(companyId, id);
    if (message.agentId !== agentId) throw forbidden("This message does not belong to the agent");
    res.json(await messages.markRead(companyId, id));
  });

  // ─── Attachments: upload (stage) + download ───────────────────────────────

  router.post("/agents/:agentId/email/attachments", async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    try {
      await runUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `File exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file || file.buffer.length === 0) {
      res.status(400).json({ error: "Missing or empty file field 'file'" });
      return;
    }
    const contentType = normalizeContentType(file.mimetype);
    const stored = await storage.putFile({
      companyId,
      namespace: `mail/${agentId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });
    const attachment = await messages.recordAttachment(companyId, null, {
      agentId,
      direction: "outbound",
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
    });
    res.status(201).json({
      ...attachment,
      contentPath: `/api/agents/${agentId}/email/attachments/${attachment.id}/content`,
    });
  });

  router.get("/agents/:agentId/email/attachments/:id/content", async (req, res, next) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const attachment = await messages.getAttachmentById(companyId, id);
    // Enforce per-agent ownership. Linked attachments are checked via their
    // message; staged (unlinked) attachments are checked via their owner agent,
    // so one agent cannot read another agent's draft attachments in the company.
    if (attachment.mailMessageId) {
      const message = await messages.getById(companyId, attachment.mailMessageId);
      if (message.agentId !== agentId) throw forbidden("This attachment does not belong to the agent");
    } else if (attachment.agentId !== agentId) {
      throw forbidden("This attachment does not belong to the agent");
    }

    const contentLength = attachment.byteSize;
    const range = parseRangeHeader(typeof req.headers.range === "string" ? req.headers.range : undefined, contentLength);
    res.setHeader("Accept-Ranges", "bytes");
    if (range.kind === "invalid") {
      res.setHeader("Content-Range", `bytes */${contentLength}`);
      res.status(416).end();
      return;
    }
    const object = await storage.getObject(
      companyId,
      attachment.objectKey,
      range.kind === "range" ? { range: { start: range.start, end: range.end } } : undefined,
    );
    const responseContentType = normalizeContentType(object.contentType ?? attachment.contentType);
    res.setHeader("Content-Type", responseContentType);
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Inline only known-safe image types (for cid images in the reader); force
    // download for everything else.
    const inline = req.query.inline === "true" && responseContentType.startsWith("image/")
      && isInlineAttachmentContentType(responseContentType);
    const filename = (attachment.originalFilename ?? "attachment").replaceAll('"', "");
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${filename}"`);
    object.stream.on("error", (err) => next(err));
    if (range.kind === "range") {
      res.status(206);
      res.setHeader("Content-Length", String(range.end - range.start + 1));
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${contentLength}`);
      object.stream.pipe(res);
      return;
    }
    res.setHeader("Content-Length", String(contentLength || object.contentLength || 0));
    object.stream.pipe(res);
  });

  // ─── Send / compose / reply ───────────────────────────────────────────────

  router.post("/agents/:agentId/email/send", validate(sendEmailSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    const from = await addresses.getById(companyId, req.body.fromAddressId);
    if (from.agentId !== agentId) throw forbidden("That address does not belong to the agent");
    if (from.status !== "active") throw unprocessable("That address is not active");
    await outboundGuard.assertNoSecretLeak(companyId, [req.body.subject, req.body.text, req.body.html]);
    const queued = await messages.enqueueOutbound(companyId, {
      addressId: from.id,
      agentId,
      fromAddr: from.address,
      toAddrs: req.body.to,
      ccAddrs: req.body.cc ?? [],
      bccAddrs: req.body.bcc ?? [],
      subject: req.body.subject ?? null,
      textBody: req.body.text ?? null,
      htmlBody: req.body.html ?? null,
      inReplyTo: req.body.inReplyTo ?? null,
      references: req.body.references ?? null,
      attachmentIds: req.body.attachmentIds ?? [],
    });
    await logActivity(db, {
      companyId,
      actorType: getActorInfo(req).actorType,
      actorId: getActorInfo(req).actorId,
      action: "email_sent",
      entityType: "mail_message",
      entityId: queued.id,
      agentId,
      details: { from: from.address, to: req.body.to, subject: req.body.subject ?? null },
    });
    res.status(202).json(queued);
  });

  // ─── Drafts ───────────────────────────────────────────────────────────────

  router.get("/agents/:agentId/email/drafts", async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    res.json(await messages.listFolder(companyId, agentId, { folder: "drafts", limit: 100, threaded: false }));
  });

  router.post("/agents/:agentId/email/drafts", validate(draftSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    const from = req.body.fromAddressId
      ? await addresses.getById(companyId, req.body.fromAddressId)
      : await defaultAddress(companyId, agentId);
    if (from.agentId !== agentId) throw forbidden("That address does not belong to the agent");
    const draft = await messages.saveDraft(companyId, agentId, {
      addressId: from.id,
      fromAddr: from.address,
      toAddrs: req.body.to,
      ccAddrs: req.body.cc,
      bccAddrs: req.body.bcc,
      subject: req.body.subject ?? null,
      textBody: req.body.text ?? null,
      htmlBody: req.body.html ?? null,
      inReplyTo: req.body.inReplyTo ?? null,
      references: req.body.references ?? null,
    });
    res.status(201).json(draft);
  });

  router.patch("/agents/:agentId/email/drafts/:id", validate(draftSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const existing = await messages.getById(companyId, id);
    if (existing.agentId !== agentId) throw forbidden("This draft does not belong to the agent");
    const from = req.body.fromAddressId
      ? await addresses.getById(companyId, req.body.fromAddressId)
      : null;
    if (from && from.agentId !== agentId) throw forbidden("That address does not belong to the agent");
    res.json(
      await messages.updateDraft(companyId, id, {
        ...(from ? { addressId: from.id, fromAddr: from.address } : {}),
        toAddrs: req.body.to,
        ccAddrs: req.body.cc,
        bccAddrs: req.body.bcc,
        subject: req.body.subject,
        textBody: req.body.text,
        htmlBody: req.body.html,
        inReplyTo: req.body.inReplyTo,
        references: req.body.references,
      }),
    );
  });

  router.delete("/agents/:agentId/email/drafts/:id", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const existing = await messages.getById(companyId, id);
    if (existing.agentId !== agentId) throw forbidden("This draft does not belong to the agent");
    const { objectKeys } = await messages.hardDelete(companyId, id);
    await Promise.all(objectKeys.map((key) => storage.deleteObject(companyId, key).catch(() => {})));
    res.status(204).end();
  });

  router.post("/agents/:agentId/email/drafts/:id/send", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const existing = await messages.getById(companyId, id);
    if (existing.agentId !== agentId) throw forbidden("This draft does not belong to the agent");
    await outboundGuard.assertNoSecretLeak(companyId, [existing.subject, existing.textBody, existing.htmlBody]);
    const queued = await messages.sendDraft(companyId, id);
    await logActivity(db, {
      companyId,
      actorType: getActorInfo(req).actorType,
      actorId: getActorInfo(req).actorId,
      action: "email_sent",
      entityType: "mail_message",
      entityId: queued.id,
      agentId,
      details: { from: queued.fromAddr, to: queued.toAddrs, subject: queued.subject },
    });
    res.status(202).json(queued);
  });

  /** Fall back to the agent's first address when a draft is saved without one. */
  async function defaultAddress(companyId: string, agentId: string) {
    const list = await addresses.list(companyId, { agentId });
    const first = list[0];
    if (!first) throw unprocessable("The agent has no email address yet");
    return first;
  }

  // ─── Domains (the agent operates the company's mail domains) ───────────────

  router.get("/agents/:agentId/email/domains", async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    res.json(await domains.list(companyId));
  });

  router.get("/agents/:agentId/email/domains/zones", async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    res.json(await domains.listAttachableZones(companyId));
  });

  router.post("/agents/:agentId/email/domains", validate(attachDomainSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId, actor } = await resolveContext(req, agentId);
    const domain = await domains.attach(companyId, req.body.domain, actor);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "mail_domain_attached",
      entityType: "mail_domain",
      entityId: domain.id,
      agentId,
      details: { domain: domain.domain, status: domain.status },
    });
    res.status(201).json(domain);
  });

  router.post("/agents/:agentId/email/domains/:id/verify", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId, actor } = await resolveContext(req, agentId);
    const domain = await domains.verify(companyId, id);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "mail_domain_verified",
      entityType: "mail_domain",
      entityId: domain.id,
      agentId,
      details: { domain: domain.domain, status: domain.status },
    });
    res.json(domain);
  });

  router.delete("/agents/:agentId/email/domains/:id", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId, actor } = await resolveContext(req, agentId);
    const domain = await domains.get(companyId, id);
    await domains.remove(companyId, id);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "mail_domain_detached",
      entityType: "mail_domain",
      entityId: id,
      agentId,
      details: { domain: domain.domain },
    });
    res.status(204).end();
  });

  // ─── DNS records (generic record CRUD on the agent's domains) ──────────────

  /** Resolve a domain the agent operates to its Cloudflare zone id. */
  async function resolveZone(companyId: string, domainId: string) {
    const domain = await domains.get(companyId, domainId);
    if (!domain.cfZoneId) throw unprocessable("This domain has no Cloudflare zone");
    return domain;
  }

  /** Normalize a record name to a FQDN within the domain ("@"/label/full name). */
  function normalizeRecordName(name: string, domain: string): string {
    const n = name.trim().replace(/\.$/, "").toLowerCase();
    const apex = domain.toLowerCase();
    if (n === "@" || n === "" || n === apex) return apex;
    return n.endsWith(`.${apex}`) ? n : `${n}.${apex}`;
  }

  router.get("/agents/:agentId/email/domains/:id/dns", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId } = await resolveContext(req, agentId);
    const domain = await resolveZone(companyId, id);
    res.json(await cloudflare.listDnsRecords(companyId, domain.cfZoneId!));
  });

  router.post("/agents/:agentId/email/domains/:id/dns", validate(createDnsRecordSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId, actor } = await resolveContext(req, agentId);
    const domain = await resolveZone(companyId, id);
    const name = normalizeRecordName(req.body.name, domain.domain);
    // Do not let the generic API shadow the mail records (MX/DKIM/SPF/DMARC).
    if (isMailManagedDnsRecord({ type: req.body.type, name, content: req.body.content }, domain)) {
      throw unprocessable("That record is managed by the mail system; it cannot be set via the DNS API");
    }
    const record = await cloudflare.createDnsRecord(companyId, domain.cfZoneId!, { ...req.body, name });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "mail_dns_record_created",
      entityType: "mail_domain",
      entityId: id,
      agentId,
      details: { type: record.type, name: record.name, content: record.content },
    });
    res.status(201).json(record);
  });

  router.delete("/agents/:agentId/email/domains/:id/dns/:recordId", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const recordId = req.params.recordId as string;
    const { companyId, actor } = await resolveContext(req, agentId);
    const domain = await resolveZone(companyId, id);
    const record = await cloudflare.getDnsRecordById(companyId, domain.cfZoneId!, recordId);
    if (isMailManagedDnsRecord(record, domain)) {
      throw unprocessable("That record is managed by the mail system; detach the domain to remove mail records");
    }
    await cloudflare.deleteDnsRecordById(companyId, domain.cfZoneId!, recordId);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "mail_dns_record_deleted",
      entityType: "mail_domain",
      entityId: id,
      agentId,
      details: { type: record.type, name: record.name },
    });
    res.status(204).end();
  });

  // ─── Sender blocklist (block an address or a whole domain) ─────────────────

  router.get("/agents/:agentId/email/blocklist", async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    res.json(await blocks.list(companyId));
  });

  router.post("/agents/:agentId/email/blocklist", validate(createSenderBlockSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId, actor } = await resolveContext(req, agentId);
    const block = await blocks.add(companyId, req.body, actor);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "mail_sender_blocked",
      entityType: "mail_sender_block",
      entityId: block.id,
      agentId,
      details: { kind: block.kind, value: block.value },
    });
    res.status(201).json(block);
  });

  router.delete("/agents/:agentId/email/blocklist/:id", async (req, res) => {
    const agentId = req.params.agentId as string;
    const id = req.params.id as string;
    const { companyId, actor } = await resolveContext(req, agentId);
    await blocks.remove(companyId, id);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "mail_sender_unblocked",
      entityType: "mail_sender_block",
      entityId: id,
      agentId,
    });
    res.status(204).end();
  });

  return router;
}
