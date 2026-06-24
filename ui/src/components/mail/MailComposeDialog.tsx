import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Paperclip, Send, X } from "lucide-react";
import type { MailAddress } from "@paperclipai/shared";
import { agentEmailApi, type StagedAttachment } from "../../api/agentEmail";
import { queryKeys } from "../../lib/queryKeys";
import { useToastActions } from "../../context/ToastContext";
import { ApiError } from "../../api/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RichTextEditor } from "./RichTextEditor";

export interface ComposeInitial {
  draftId?: string;
  fromAddressId?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
}

interface Props {
  agentId: string;
  open: boolean;
  initial: ComposeInitial | null;
  onClose: () => void;
  onSent: () => void;
}

function parseEmails(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function htmlToText(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent?.trim() ?? "";
}

export function MailComposeDialog({ agentId, open, initial, onClose, onSent }: Props) {
  const { pushToast } = useToastActions();
  const addressesQuery = useQuery({
    queryKey: queryKeys.agentMail.addresses(agentId),
    queryFn: () => agentEmailApi.listAddresses(agentId),
    enabled: open,
  });
  const addresses: MailAddress[] = addressesQuery.data ?? [];

  const [fromAddressId, setFromAddressId] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const draftIdRef = useRef<string | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset the form from the initial payload whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    draftIdRef.current = initial?.draftId;
    setTo((initial?.to ?? []).join(", "));
    setCc((initial?.cc ?? []).join(", "));
    setBcc((initial?.bcc ?? []).join(", "));
    setShowCcBcc(Boolean(initial?.cc?.length || initial?.bcc?.length));
    setSubject(initial?.subject ?? "");
    setHtml(initial?.html ?? "");
    setAttachments([]);
  }, [open, initial]);

  // Default the from-address once addresses load.
  useEffect(() => {
    if (open && !fromAddressId && addresses.length > 0) {
      setFromAddressId(initial?.fromAddressId ?? addresses[0].id);
    }
  }, [open, fromAddressId, addresses, initial]);

  const uploadMutation = useMutation({
    mutationFn: (file: File) => agentEmailApi.uploadAttachment(agentId, file),
    onSuccess: (att) => setAttachments((prev) => [...prev, att]),
    onError: (e) => pushToast({ tone: "error", title: e instanceof ApiError ? e.message : "Upload failed" }),
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!fromAddressId) throw new Error("Pick a from address");
      const recipients = parseEmails(to);
      if (recipients.length === 0) throw new Error("Add at least one recipient");
      await agentEmailApi.send(agentId, {
        fromAddressId,
        to: recipients,
        cc: parseEmails(cc),
        bcc: parseEmails(bcc),
        subject: subject || undefined,
        html: html || undefined,
        text: htmlToText(html) || undefined,
        inReplyTo: initial?.inReplyTo,
        references: initial?.references,
        attachmentIds: attachments.map((a) => a.id),
      });
      if (draftIdRef.current) await agentEmailApi.deleteDraft(agentId, draftIdRef.current).catch(() => {});
    },
    onSuccess: () => {
      pushToast({ tone: "success", title: "Email queued" });
      onSent();
      onClose();
    },
    onError: (e) => pushToast({ tone: "error", title: e instanceof ApiError ? e.message : String(e) }),
  });

  // Debounced draft autosave (text fields only).
  useEffect(() => {
    if (!open || !fromAddressId) return;
    const handle = setTimeout(async () => {
      const payload = {
        fromAddressId,
        to: parseEmails(to),
        cc: parseEmails(cc),
        bcc: parseEmails(bcc),
        subject: subject || undefined,
        html: html || undefined,
        text: htmlToText(html) || undefined,
        inReplyTo: initial?.inReplyTo,
        references: initial?.references,
      };
      const hasContent = payload.to.length || payload.subject || (payload.text && payload.text.length);
      if (!hasContent) return;
      try {
        if (draftIdRef.current) {
          await agentEmailApi.updateDraft(agentId, draftIdRef.current, payload);
        } else {
          const draft = await agentEmailApi.createDraft(agentId, payload);
          draftIdRef.current = draft.id;
        }
      } catch {
        /* autosave is best-effort */
      }
    }, 1500);
    return () => clearTimeout(handle);
  }, [open, agentId, fromAddressId, to, cc, bcc, subject, html, initial]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="w-12 text-xs text-muted-foreground">From</span>
            <Select value={fromAddressId} onValueChange={setFromAddressId}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="From address" />
              </SelectTrigger>
              <SelectContent>
                {addresses.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.address}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12 text-xs text-muted-foreground">To</span>
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@example.com, ..." className="flex-1" />
            {!showCcBcc && (
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowCcBcc(true)}>
                Cc/Bcc
              </button>
            )}
          </div>
          {showCcBcc && (
            <>
              <div className="flex items-center gap-2">
                <span className="w-12 text-xs text-muted-foreground">Cc</span>
                <Input value={cc} onChange={(e) => setCc(e.target.value)} className="flex-1" />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-12 text-xs text-muted-foreground">Bcc</span>
                <Input value={bcc} onChange={(e) => setBcc(e.target.value)} className="flex-1" />
              </div>
            </>
          )}
          <div className="flex items-center gap-2">
            <span className="w-12 text-xs text-muted-foreground">Subject</span>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="flex-1" />
          </div>
          <RichTextEditor value={html} onChange={setHtml} />
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((a) => (
                <span key={a.id} className="inline-flex items-center gap-1 rounded border bg-muted/40 px-2 py-1 text-xs">
                  <Paperclip className="h-3 w-3" />
                  {a.originalFilename ?? "attachment"}
                  <button type="button" onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          <div>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadMutation.mutate(file);
                e.target.value = "";
              }}
            />
            <Button variant="outline" size="sm" disabled={uploadMutation.isPending} onClick={() => fileInputRef.current?.click()}>
              {uploadMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
              Attach
            </Button>
          </div>
          <Button disabled={sendMutation.isPending} onClick={() => sendMutation.mutate()}>
            {sendMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
