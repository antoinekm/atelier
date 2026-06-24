import { Archive, Loader2, Paperclip, RefreshCw, Star, Trash2 } from "lucide-react";
import type { MailFolder, MailMessageListItem, MailMessageStatus, MailThreadSummary } from "@paperclipai/shared";
import { relativeTime } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Row = MailThreadSummary | MailMessageListItem;

function isSummary(row: Row): row is MailThreadSummary {
  return "messageCount" in row;
}

interface RowView {
  key: string;
  title: string;
  subject: string | null;
  snippet: string;
  time: string | Date;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  status: MailMessageStatus;
  error: string | null;
  count: number;
}

function toView(row: Row): RowView {
  if (isSummary(row)) {
    return {
      key: row.threadId,
      title: row.participants.filter(Boolean).slice(0, 2).join(", ") || "(unknown)",
      subject: row.subject,
      snippet: row.snippet,
      time: row.lastMessageAt,
      unread: row.unreadCount > 0,
      starred: row.isStarred,
      hasAttachments: row.hasAttachments,
      status: row.lastStatus,
      error: row.lastError,
      count: row.messageCount,
    };
  }
  return {
    key: row.id,
    title: row.direction === "outbound" ? `To: ${row.toAddrs.join(", ")}` : row.fromAddr,
    subject: row.subject,
    snippet: row.snippet,
    time: row.createdAt,
    unread: row.status === "received",
    starred: row.isStarred,
    hasAttachments: row.hasAttachments,
    status: row.status,
    error: row.error,
    count: 1,
  };
}

const STATUS_BADGE: Partial<Record<MailMessageStatus, { label: string; cls: string }>> = {
  draft: { label: "Draft", cls: "text-muted-foreground" },
  queued: { label: "Sending", cls: "text-amber-600" },
  sending: { label: "Sending", cls: "text-amber-600" },
  sent: { label: "Sent", cls: "text-emerald-600" },
  failed: { label: "Failed", cls: "text-destructive" },
  bounced: { label: "Bounced", cls: "text-destructive" },
};

interface Props {
  items: Row[];
  selectedKey: string | null;
  folder: MailFolder;
  isLoading: boolean;
  hasMore: boolean;
  onOpen: (row: Row) => void;
  onLoadMore: () => void;
  onToggleStar: (row: Row) => void;
  onArchive: (row: Row) => void;
  onTrash: (row: Row) => void;
  onRetry: (row: Row) => void;
}

export function MailMessageList({
  items,
  selectedKey,
  folder,
  isLoading,
  hasMore,
  onOpen,
  onLoadMore,
  onToggleStar,
  onArchive,
  onTrash,
  onRetry,
}: Props) {
  if (isLoading && items.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (items.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No messages in {folder}.</div>;
  }
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {items.map((row) => {
        const v = toView(row);
        const badge = folder === "sent" || folder === "drafts" ? STATUS_BADGE[v.status] : undefined;
        return (
          <div
            key={v.key}
            onClick={() => onOpen(row)}
            className={cn(
              "group flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-sm hover:bg-muted/50",
              selectedKey === v.key && "bg-muted",
              v.unread && "font-semibold",
            )}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleStar(row);
              }}
              className="shrink-0 text-muted-foreground hover:text-amber-500"
              title="Star"
            >
              <Star className={cn("h-4 w-4", v.starred && "fill-amber-400 text-amber-500")} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate">{v.title}</span>
                {v.count > 1 && <span className="text-xs text-muted-foreground">{v.count}</span>}
                <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">{relativeTime(v.time)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="truncate">{v.subject || "(no subject)"}</span>
                {v.hasAttachments && <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />}
              </div>
              <div className="flex items-center gap-2">
                <span className="truncate text-xs font-normal text-muted-foreground">{v.snippet}</span>
                {badge && <span className={cn("shrink-0 text-xs font-normal", badge.cls)}>{badge.label}</span>}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
              {(v.status === "failed" || v.status === "bounced") && (
                <button type="button" title="Retry" onClick={(e) => { e.stopPropagation(); onRetry(row); }} className="rounded p-1 hover:bg-background">
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              )}
              {folder !== "trash" && (
                <button type="button" title="Archive" onClick={(e) => { e.stopPropagation(); onArchive(row); }} className="rounded p-1 hover:bg-background">
                  <Archive className="h-3.5 w-3.5" />
                </button>
              )}
              <button type="button" title="Trash" onClick={(e) => { e.stopPropagation(); onTrash(row); }} className="rounded p-1 hover:bg-background">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        );
      })}
      {hasMore && (
        <div className="p-2">
          <Button variant="outline" size="sm" className="w-full" disabled={isLoading} onClick={onLoadMore}>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
