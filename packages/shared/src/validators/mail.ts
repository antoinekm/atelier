import { z } from "zod";
import { MAIL_FOLDERS, MAIL_MESSAGE_STATUSES, MAIL_SENDER_BLOCK_KINDS } from "../constants.js";

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * Connect a Cloudflare account by API token (embedded mail, phase 0). The token
 * is validated against the Cloudflare API and stored as a company secret; only
 * the secret id is persisted on the connection row.
 */
export const connectCloudflareSchema = z.object({
  apiToken: z.string().trim().min(1).max(400),
  // Optional: pin a specific Cloudflare account; otherwise resolved from the token.
  cfAccountId: z.string().trim().max(120).optional(),
});
export type ConnectCloudflare = z.infer<typeof connectCloudflareSchema>;

/**
 * Attach an existing domain (a zone the connected account already owns) and
 * configure its mail DNS. Domain registration is out of scope for V1.
 */
export const attachDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
      "Must be a valid domain name",
    ),
});
export type AttachDomain = z.infer<typeof attachDomainSchema>;

/** Create an email address on an attached domain (phase 1). */
export const createMailAddressSchema = z.object({
  domainId: z.string().uuid(),
  // The local part (before @). Use "*" for a catch-all address.
  localPart: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^(\*|[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)$/i, "Invalid local part"),
  kind: z.enum(["mailbox", "alias", "catch_all"]).optional(),
  // Owning agent (company-level create only; null/omitted = company-shared).
  agentId: z.string().uuid().nullable().optional(),
});
export type CreateMailAddress = z.infer<typeof createMailAddressSchema>;

/**
 * Compose / reply / forward an email from one of the agent's addresses. Bodies
 * and attachments are both optional individually, but at least one must be
 * present. `attachmentIds` reference attachments previously staged via upload.
 */
export const sendEmailSchema = z
  .object({
    fromAddressId: z.string().uuid(),
    to: z.array(z.string().email()).min(1).max(50),
    cc: z.array(z.string().email()).max(50).optional(),
    bcc: z.array(z.string().email()).max(50).optional(),
    subject: z.string().max(998).optional(),
    text: z.string().max(100_000).optional(),
    html: z.string().max(500_000).optional(),
    inReplyTo: z.string().max(998).optional(),
    references: z.string().max(4000).optional(),
    attachmentIds: z.array(z.string().uuid()).max(20).optional(),
  })
  .refine((d) => Boolean(d.text || d.html || (d.attachmentIds && d.attachmentIds.length > 0)), {
    message: "Provide a text or html body, or at least one attachment",
  });
export type SendEmail = z.infer<typeof sendEmailSchema>;

/**
 * Create or update a draft. Everything is optional (a draft can be half-written);
 * `fromAddressId` is validated when present and required only at send time.
 */
export const draftSchema = z.object({
  fromAddressId: z.string().uuid().optional(),
  to: z.array(z.string().email()).max(50).optional(),
  cc: z.array(z.string().email()).max(50).optional(),
  bcc: z.array(z.string().email()).max(50).optional(),
  subject: z.string().max(998).optional(),
  text: z.string().max(100_000).optional(),
  html: z.string().max(500_000).optional(),
  inReplyTo: z.string().max(998).optional(),
  references: z.string().max(4000).optional(),
  attachmentIds: z.array(z.string().uuid()).max(20).optional(),
});
export type DraftInput = z.infer<typeof draftSchema>;

/** Toggle Gmail-like flags on a message (any subset). */
export const mailFlagSchema = z
  .object({
    isStarred: z.boolean().optional(),
    isArchived: z.boolean().optional(),
    isRead: z.boolean().optional(),
  })
  .refine((d) => d.isStarred !== undefined || d.isArchived !== undefined || d.isRead !== undefined, {
    message: "Provide at least one flag to change",
  });
export type MailFlagInput = z.infer<typeof mailFlagSchema>;

/** Folder/search/paginated/threaded list query for the mail client. */
export const mailListQuerySchema = z.object({
  folder: z.enum(MAIL_FOLDERS).default("inbox"),
  q: z.string().trim().max(200).optional(),
  status: z.enum(MAIL_MESSAGE_STATUSES).optional(),
  starred: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(120).optional(),
  threaded: z.coerce.boolean().optional().default(true),
});
export type MailListQuery = z.infer<typeof mailListQuerySchema>;

/** Block a sender: a single address or a whole domain (incl. subdomains). */
export const createSenderBlockSchema = z
  .object({
    kind: z.enum(MAIL_SENDER_BLOCK_KINDS),
    value: z.string().trim().min(1).max(253),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((d, ctx) => {
    const value = d.value.toLowerCase();
    if (d.kind === "address" && !z.string().email().safeParse(value).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Must be a valid email address" });
    }
    if (d.kind === "domain" && !DOMAIN_RE.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Must be a valid domain" });
    }
  });
export type CreateSenderBlock = z.infer<typeof createSenderBlockSchema>;

/** Create a DNS record on one of the agent's domains (generic DNS management). */
export const createDnsRecordSchema = z.object({
  type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX"]),
  // A subdomain label ("tools"), "@" for the apex, or a full name ("tools.example.com").
  name: z.string().trim().min(1).max(253),
  content: z.string().trim().min(1).max(2048),
  ttl: z.number().int().min(60).max(86_400).optional(),
  proxied: z.boolean().optional(),
  priority: z.number().int().min(0).max(65_535).optional(),
});
export type CreateDnsRecord = z.infer<typeof createDnsRecordSchema>;

/** Inbox listing query (agent run-context API; kept stable for back-compat). */
export const mailInboxQuerySchema = z.object({
  since: z.string().datetime().optional(),
  status: z.enum(["received", "read"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type MailInboxQuery = z.infer<typeof mailInboxQuerySchema>;
