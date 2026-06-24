import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import type {
  MailFolder,
  MailMessage,
  MailMessageListItem,
  MailThreadSummary,
} from "@paperclipai/shared";
import { agentEmailApi } from "../../api/agentEmail";
import { queryKeys } from "../../lib/queryKeys";
import { formatDateTime } from "../../lib/utils";
import { useToastActions } from "../../context/ToastContext";
import { Input } from "@/components/ui/input";
import { MailFolderRail } from "./MailFolderRail";
import { MailMessageList } from "./MailMessageList";
import { MailReadingPane } from "./MailReadingPane";
import { MailComposeDialog, type ComposeInitial } from "./MailComposeDialog";
import { useMailKeyboard } from "./useMailKeyboard";

type Row = MailThreadSummary | MailMessageListItem;
const THREADED_FOLDERS: MailFolder[] = ["inbox", "starred", "archive", "trash"];

function rowKey(row: Row): string {
  return "messageCount" in row ? row.threadId : row.id;
}
function rowThreadId(row: Row): string | null {
  return "messageCount" in row ? row.threadId : row.threadId;
}
function rowMessageId(row: Row): string | null {
  return "messageCount" in row ? null : row.id;
}

function stripRe(subject: string | null): string {
  return (subject ?? "").replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, "").trim();
}

function quoteBody(m: MailMessage): string {
  const original = m.htmlBody ?? `<pre>${(m.textBody ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre>`;
  return `<p></p><blockquote style="border-left:2px solid #ccc;padding-left:8px;color:#666">On ${formatDateTime(m.createdAt)}, ${m.fromAddr} wrote:<br>${original}</blockquote>`;
}

export function AgentMailTab({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [searchInput, setSearchInput] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [compose, setCompose] = useState<{ open: boolean; initial: ComposeInitial | null }>({ open: false, initial: null });
  const searchRef = useRef<HTMLInputElement>(null);

  const threaded = THREADED_FOLDERS.includes(folder);

  useEffect(() => {
    const h = setTimeout(() => setSearchQ(searchInput.trim()), 300);
    return () => clearTimeout(h);
  }, [searchInput]);

  // Reset selection when the folder or search changes.
  useEffect(() => {
    setSelectedThreadId(null);
    setActiveIndex(0);
  }, [folder, searchQ]);

  const listQuery = useInfiniteQuery({
    queryKey: queryKeys.agentMail.list(agentId, folder, searchQ),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      agentEmailApi.listMessages(agentId, { folder, q: searchQ || undefined, cursor: pageParam, threaded }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const foldersQuery = useQuery({
    queryKey: queryKeys.agentMail.folders(agentId),
    queryFn: () => agentEmailApi.folderCounts(agentId),
    refetchInterval: 30_000,
  });

  const items = useMemo<Row[]>(() => (listQuery.data?.pages ?? []).flatMap((p) => p.items as Row[]), [listQuery.data]);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["agent-mail", agentId] });
  }, [queryClient, agentId]);

  const flagMutation = useMutation({
    mutationFn: ({ id, flags }: { id: string; flags: { isStarred?: boolean; isArchived?: boolean; isRead?: boolean } }) =>
      agentEmailApi.setFlags(agentId, id, flags),
    onSuccess: invalidate,
    onError: () => pushToast({ tone: "error", title: "Action failed" }),
  });
  const trashMutation = useMutation({
    mutationFn: (id: string) => agentEmailApi.trash(agentId, id),
    onSuccess: invalidate,
  });
  const retryMutation = useMutation({
    mutationFn: (id: string) => agentEmailApi.retry(agentId, id),
    onSuccess: () => {
      pushToast({ tone: "success", title: "Re-queued" });
      invalidate();
    },
  });

  // Resolve a row to a concrete message id to flag (thread → its messages need a fetch;
  // for simplicity we act on the representative message id when available).
  const actOnRow = useCallback(
    async (row: Row, action: "star" | "archive" | "trash" | "retry") => {
      const tid = rowThreadId(row);
      const mid = rowMessageId(row);
      // Resolve target message ids: a flat row is itself; a thread acts on all its messages.
      let ids: string[] = [];
      if (mid) ids = [mid];
      else if (tid) {
        const thread = await agentEmailApi.getThread(agentId, tid).catch(() => null);
        ids = thread ? thread.messages.map((m) => m.id) : [];
      }
      if (ids.length === 0) return;
      if (action === "star") await Promise.all(ids.map((id) => flagMutation.mutateAsync({ id, flags: { isStarred: !("isStarred" in row ? row.isStarred : false) } })));
      else if (action === "archive") await Promise.all(ids.map((id) => flagMutation.mutateAsync({ id, flags: { isArchived: true } })));
      else if (action === "trash") await Promise.all(ids.map((id) => trashMutation.mutateAsync(id)));
      else if (action === "retry") await Promise.all(ids.map((id) => retryMutation.mutateAsync(id)));
    },
    [agentId, flagMutation, trashMutation, retryMutation],
  );

  const openDraft = useCallback(
    async (id: string) => {
      const draft = await agentEmailApi.getMessage(agentId, id).catch(() => null);
      if (!draft) return;
      setCompose({
        open: true,
        initial: {
          draftId: draft.id,
          to: draft.toAddrs,
          cc: draft.ccAddrs,
          bcc: draft.bccAddrs,
          subject: draft.subject ?? undefined,
          html: draft.htmlBody ?? (draft.textBody ? `<p>${draft.textBody}</p>` : ""),
          inReplyTo: draft.inReplyTo ?? undefined,
          references: draft.references ?? undefined,
        },
      });
    },
    [agentId],
  );

  const onOpen = useCallback(
    (row: Row) => {
      if (folder === "drafts") {
        const mid = rowMessageId(row);
        if (mid) void openDraft(mid);
        return;
      }
      const tid = rowThreadId(row);
      if (tid) {
        setSelectedThreadId(tid);
        // Mark the conversation read in the background.
        if ("unreadCount" in row && row.unreadCount > 0) invalidateAfterRead(tid);
      }
    },
    [folder, openDraft],
  );

  const invalidateAfterRead = useCallback(
    async (threadId: string) => {
      const thread = await agentEmailApi.getThread(agentId, threadId).catch(() => null);
      if (!thread) return;
      await Promise.all(
        thread.messages
          .filter((m) => m.status === "received")
          .map((m) => agentEmailApi.markRead(agentId, m.id).catch(() => null)),
      );
      invalidate();
    },
    [agentId, invalidate],
  );

  const buildReply = useCallback((m: MailMessage, mode: "reply" | "replyAll" | "forward"): ComposeInitial => {
    const base: ComposeInitial = {
      fromAddressId: m.addressId,
      inReplyTo: m.messageId ?? undefined,
      references: `${m.references ? m.references + " " : ""}${m.messageId ?? ""}`.trim() || undefined,
      html: quoteBody(m),
    };
    if (mode === "forward") return { ...base, subject: `Fwd: ${stripRe(m.subject)}`, inReplyTo: undefined };
    const subject = `Re: ${stripRe(m.subject)}`;
    if (mode === "reply") return { ...base, subject, to: [m.fromAddr] };
    const cc = Array.from(new Set([...m.toAddrs, ...m.ccAddrs])).filter((a) => a !== m.fromAddr);
    return { ...base, subject, to: [m.fromAddr], cc };
  }, []);

  const openReply = useCallback((m: MailMessage, mode: "reply" | "replyAll" | "forward") => {
    setCompose({ open: true, initial: buildReply(m, mode) });
  }, [buildReply]);

  // Keyboard shortcuts.
  const activeRow = items[activeIndex];
  useMailKeyboard(!compose.open, {
    next: () => setActiveIndex((i) => Math.min(i + 1, items.length - 1)),
    prev: () => setActiveIndex((i) => Math.max(i - 1, 0)),
    open: () => activeRow && onOpen(activeRow),
    compose: () => setCompose({ open: true, initial: null }),
    reply: () => {},
    replyAll: () => {},
    forward: () => {},
    archive: () => activeRow && void actOnRow(activeRow, "archive"),
    trash: () => activeRow && void actOnRow(activeRow, "trash"),
    toggleStar: () => activeRow && void actOnRow(activeRow, "star"),
    toggleUnread: () => {},
    focusSearch: () => searchRef.current?.focus(),
    escape: () => setSelectedThreadId(null),
    help: () => pushToast({ tone: "info", title: "Shortcuts", body: "j/k move · enter open · c compose · e archive · # trash · s star · / search" }),
  });

  return (
    <div className="grid h-[calc(100vh-220px)] grid-cols-[180px_minmax(280px,1fr)] overflow-hidden rounded-lg border lg:grid-cols-[180px_minmax(300px,420px)_minmax(0,1fr)]">
      <MailFolderRail
        folder={folder}
        counts={foldersQuery.data}
        onSelect={setFolder}
        onCompose={() => setCompose({ open: true, initial: null })}
      />
      <div className="flex min-w-0 flex-col border-r">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search mail"
            className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <MailMessageList
          items={items}
          selectedKey={selectedThreadId ?? (activeRow ? rowKey(activeRow) : null)}
          folder={folder}
          isLoading={listQuery.isLoading || listQuery.isFetchingNextPage}
          hasMore={Boolean(listQuery.hasNextPage)}
          onOpen={onOpen}
          onLoadMore={() => listQuery.fetchNextPage()}
          onToggleStar={(row) => void actOnRow(row, "star")}
          onArchive={(row) => void actOnRow(row, "archive")}
          onTrash={(row) => void actOnRow(row, "trash")}
          onRetry={(row) => void actOnRow(row, "retry")}
        />
      </div>
      <div className="hidden min-w-0 lg:block">
        {selectedThreadId ? (
          <MailReadingPane
            agentId={agentId}
            threadId={selectedThreadId}
            onReply={(m) => openReply(m, "reply")}
            onReplyAll={(m) => openReply(m, "replyAll")}
            onForward={(m) => openReply(m, "forward")}
            onClose={() => setSelectedThreadId(null)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a conversation
          </div>
        )}
      </div>

      <MailComposeDialog
        agentId={agentId}
        open={compose.open}
        initial={compose.initial}
        onClose={() => setCompose({ open: false, initial: null })}
        onSent={invalidate}
      />
    </div>
  );
}
