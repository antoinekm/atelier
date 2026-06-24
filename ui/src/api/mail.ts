import type { CloudflareConnection, CloudflareZone, MailDomain } from "@paperclipai/shared";
import { api } from "./client";

export interface CloudflareConnectionState {
  connection: CloudflareConnection | null;
  oauthAvailable: boolean;
}

/** Embedded mail: Cloudflare connection + attached mail domains (phase 0). */
export const mailApi = {
  getCloudflareConnection: (companyId: string) =>
    api.get<CloudflareConnectionState>(`/companies/${companyId}/integrations/cloudflare`),
  startCloudflareOAuth: (companyId: string) =>
    api.get<{ authorizeUrl: string }>(`/companies/${companyId}/integrations/cloudflare/oauth/start`),
  connectCloudflare: (companyId: string, apiToken: string, cfAccountId?: string) =>
    api.post<CloudflareConnection>(`/companies/${companyId}/integrations/cloudflare`, {
      apiToken,
      ...(cfAccountId ? { cfAccountId } : {}),
    }),
  disconnectCloudflare: (companyId: string) =>
    api.delete<void>(`/companies/${companyId}/integrations/cloudflare`),
  listZones: (companyId: string) =>
    api.get<CloudflareZone[]>(`/companies/${companyId}/integrations/cloudflare/zones`),

  listDomains: (companyId: string) =>
    api.get<MailDomain[]>(`/companies/${companyId}/mail/domains`),
  attachDomain: (companyId: string, domain: string) =>
    api.post<MailDomain>(`/companies/${companyId}/mail/domains`, { domain }),
  verifyDomain: (companyId: string, id: string) =>
    api.post<MailDomain>(`/companies/${companyId}/mail/domains/${id}/verify`, {}),
  removeDomain: (companyId: string, id: string) =>
    api.delete<void>(`/companies/${companyId}/mail/domains/${id}`),
};
