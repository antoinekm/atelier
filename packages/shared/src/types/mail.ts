import type {
  CloudflareConnectionStatus,
  MailAddressKind,
  MailDomainStatus,
  MailMessageDirection,
  MailMessageStatus,
} from "../constants.js";

/**
 * A company's Cloudflare connection, projected for the API. The stored API-token
 * secret id is never exposed here.
 */
export interface CloudflareConnection {
  id: string;
  companyId: string;
  cfAccountId: string | null;
  status: CloudflareConnectionStatus;
  scopes: string[];
  verifiedAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/** A Cloudflare zone the human can attach (from the connected account). */
export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
}

/**
 * A domain attached for embedded email, projected for the API. Secret ids (DKIM
 * private key) are never exposed; the DKIM public key is published in DNS anyway.
 */
export interface MailDomain {
  id: string;
  companyId: string;
  domain: string;
  provider: string;
  cfZoneId: string | null;
  status: MailDomainStatus;
  dkimSelector: string;
  dkimPublicKey: string | null;
  mxConfigured: boolean;
  spfConfigured: boolean;
  dmarcConfigured: boolean;
  lastError: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/** An email address on an attached mail domain. */
export interface MailAddress {
  id: string;
  companyId: string;
  domainId: string;
  agentId: string | null;
  localPart: string;
  address: string;
  kind: MailAddressKind;
  status: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/** A stored email message (inbound in phase 1; outbound in phase 2). */
export interface MailMessage {
  id: string;
  companyId: string;
  addressId: string;
  agentId: string | null;
  direction: MailMessageDirection;
  messageId: string | null;
  inReplyTo: string | null;
  fromAddr: string;
  toAddrs: string[];
  ccAddrs: string[];
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  status: MailMessageStatus;
  readAt: string | Date | null;
  createdAt: string | Date;
}
