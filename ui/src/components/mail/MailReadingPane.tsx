import { useQuery } from "@tanstack/react-query";
import { CornerUpLeft, CornerUpRight, Download, Paperclip, ReplyAll, X } from "lucide-react";
import type { MailMessage } from "@paperclipai/shared";
import { agentEmailApi } from "../../api/agentEmail";
import { queryKeys } from "../../lib/queryKeys";
import { formatDateTime } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { MailHtmlBody } from "./MailHtmlBody";

interface Props {
  agentId: string;
  threadId: string;
  onReply: (m: MailMessage) => void;
  onReplyAll: (m: MailMessage) => void;
  onForward: (m: MailMessage) => void;
  onClose: () => void;
}

function MessageCard({ agentId, m, onReply, onReplyAll, onForward }: { agentId: string; m: MailMessage } & Pick<Props, "onReply" | "onReplyAll" | "onForward">) {
  return (
    <div className="rounded-lg border">
      <div className="flex items-start justify-between gap-2 border-b px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{m.fromAddr}</div>
          <div className="truncate text-xs text-muted-foreground">to {m.toAddrs.join(", ")}{m.ccAddrs.length > 0 ? `, cc ${m.ccAddrs.join(", ")}` : ""}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-xs text-muted-foreground">{formatDateTime(m.createdAt)}</span>
          <Button size="icon-sm" variant="ghost" title="Reply" onClick={() => onReply(m)}>
            <CornerUpLeft className="h-4 w-4" />
          </Button>
          <Button size="icon-sm" variant="ghost" title="Reply all" onClick={() => onReplyAll(m)}>
            <ReplyAll className="h-4 w-4" />
          </Button>
          <Button size="icon-sm" variant="ghost" title="Forward" onClick={() => onForward(m)}>
            <CornerUpRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="px-4 py-3">
        {m.htmlBody ? (
          <MailHtmlBody html={m.htmlBody} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm">{m.textBody ?? "(empty)"}</pre>
        )}
        {m.attachments.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5 border-t pt-3">
            {m.attachments.map((a) => (
              <a
                key={a.id}
                href={agentEmailApi.attachmentContentUrl(agentId, a.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded border bg-muted/40 px-2 py-1 text-xs hover:bg-muted"
              >
                <Paperclip className="h-3 w-3" />
                {a.originalFilename ?? "attachment"}
                <Download className="h-3 w-3" />
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function MailReadingPane({ agentId, threadId, onReply, onReplyAll, onForward, onClose }: Props) {
  const threadQuery = useQuery({
    queryKey: queryKeys.agentMail.thread(agentId, threadId),
    queryFn: () => agentEmailApi.getThread(agentId, threadId),
  });

  if (threadQuery.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (threadQuery.isError || !threadQuery.data) return <div className="p-6 text-sm text-destructive">Failed to load the conversation.</div>;

  const thread = threadQuery.data;
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b bg-background px-4 py-2.5">
        <h2 className="truncate text-base font-semibold">{thread.subject || "(no subject)"}</h2>
        <Button size="icon-sm" variant="ghost" onClick={onClose} title="Close">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex flex-col gap-3 p-4">
        {thread.messages.map((m) => (
          <MessageCard key={m.id} agentId={agentId} m={m} onReply={onReply} onReplyAll={onReplyAll} onForward={onForward} />
        ))}
      </div>
    </div>
  );
}
