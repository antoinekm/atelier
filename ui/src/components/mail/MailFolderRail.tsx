import { Archive, FileEdit, Inbox, Send, Star, Trash2, PenSquare } from "lucide-react";
import type { MailFolder, MailFolderCounts } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const FOLDERS: { key: MailFolder; label: string; icon: typeof Inbox }[] = [
  { key: "inbox", label: "Inbox", icon: Inbox },
  { key: "starred", label: "Starred", icon: Star },
  { key: "sent", label: "Sent", icon: Send },
  { key: "drafts", label: "Drafts", icon: FileEdit },
  { key: "archive", label: "Archive", icon: Archive },
  { key: "trash", label: "Trash", icon: Trash2 },
];

interface Props {
  folder: MailFolder;
  counts: MailFolderCounts | undefined;
  onSelect: (folder: MailFolder) => void;
  onCompose: () => void;
}

export function MailFolderRail({ folder, counts, onSelect, onCompose }: Props) {
  const badgeFor = (key: MailFolder): number => {
    if (!counts) return 0;
    if (key === "inbox") return counts.inbox;
    if (key === "drafts") return counts.drafts;
    return 0;
  };
  return (
    <div className="flex flex-col gap-1 border-r p-2">
      <Button className="mb-2 w-full justify-start gap-2" onClick={onCompose}>
        <PenSquare className="h-4 w-4" /> Compose
      </Button>
      {FOLDERS.map(({ key, label, icon: Icon }) => {
        const badge = badgeFor(key);
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm hover:bg-muted",
              folder === key && "bg-muted font-medium",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">{label}</span>
            {badge > 0 && <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
