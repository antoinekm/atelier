import type {
  DraftInput,
  MailAddress,
  MailAttachment,
  MailFlagInput,
  MailFolder,
  MailFolderCounts,
  MailListPage,
  MailMessage,
  MailMessageListItem,
  MailThread,
  MailThreadSummary,
  SendEmail,
} from "@paperclipai/shared";
import { api } from "./client";

export interface MailListParams {
  folder: MailFolder;
  q?: string;
  status?: string;
  starred?: boolean;
  cursor?: string;
  threaded?: boolean;
  limit?: number;
}

export interface StagedAttachment extends MailAttachment {
  contentPath: string;
}

function listQuery(params: MailListParams): string {
  const sp = new URLSearchParams();
  sp.set("folder", params.folder);
  if (params.q) sp.set("q", params.q);
  if (params.status) sp.set("status", params.status);
  if (params.starred !== undefined) sp.set("starred", String(params.starred));
  if (params.cursor) sp.set("cursor", params.cursor);
  if (params.threaded !== undefined) sp.set("threaded", String(params.threaded));
  if (params.limit) sp.set("limit", String(params.limit));
  return sp.toString();
}

/** Per-agent mailbox API (the mini Gmail client). */
export const agentEmailApi = {
  listAddresses: (agentId: string) => api.get<MailAddress[]>(`/agents/${agentId}/email/addresses`),

  listMessages: (agentId: string, params: MailListParams) =>
    api.get<MailListPage<MailMessageListItem | MailThreadSummary>>(
      `/agents/${agentId}/email/messages?${listQuery(params)}`,
    ),

  folderCounts: (agentId: string) => api.get<MailFolderCounts>(`/agents/${agentId}/email/folders`),

  getThread: (agentId: string, threadId: string) =>
    api.get<MailThread>(`/agents/${agentId}/email/threads/${threadId}`),

  getMessage: (agentId: string, id: string) =>
    api.get<MailMessage>(`/agents/${agentId}/email/messages/${id}`),

  setFlags: (agentId: string, id: string, flags: MailFlagInput) =>
    api.patch<MailMessage>(`/agents/${agentId}/email/messages/${id}/flags`, flags),

  trash: (agentId: string, id: string) =>
    api.post<MailMessage>(`/agents/${agentId}/email/messages/${id}/trash`, {}),
  restore: (agentId: string, id: string) =>
    api.post<MailMessage>(`/agents/${agentId}/email/messages/${id}/restore`, {}),
  hardDelete: (agentId: string, id: string) =>
    api.delete<void>(`/agents/${agentId}/email/messages/${id}`),
  retry: (agentId: string, id: string) =>
    api.post<MailMessage>(`/agents/${agentId}/email/messages/${id}/retry`, {}),
  markRead: (agentId: string, id: string) =>
    api.post<MailMessage>(`/agents/${agentId}/email/messages/${id}/read`, {}),

  send: (agentId: string, body: SendEmail) =>
    api.post<MailMessage>(`/agents/${agentId}/email/send`, body),

  uploadAttachment: (agentId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api.postForm<StagedAttachment>(`/agents/${agentId}/email/attachments`, form);
  },
  attachmentContentUrl: (agentId: string, id: string, inline = false) =>
    `/api/agents/${agentId}/email/attachments/${id}/content${inline ? "?inline=true" : ""}`,

  listDrafts: (agentId: string) =>
    api.get<MailListPage<MailMessageListItem>>(`/agents/${agentId}/email/drafts`),
  createDraft: (agentId: string, body: DraftInput) =>
    api.post<MailMessage>(`/agents/${agentId}/email/drafts`, body),
  updateDraft: (agentId: string, id: string, body: DraftInput) =>
    api.patch<MailMessage>(`/agents/${agentId}/email/drafts/${id}`, body),
  deleteDraft: (agentId: string, id: string) =>
    api.delete<void>(`/agents/${agentId}/email/drafts/${id}`),
  sendDraft: (agentId: string, id: string) =>
    api.post<MailMessage>(`/agents/${agentId}/email/drafts/${id}/send`, {}),
};
