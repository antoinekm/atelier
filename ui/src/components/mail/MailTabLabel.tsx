import { useQuery } from "@tanstack/react-query";
import { agentEmailApi } from "../../api/agentEmail";
import { queryKeys } from "../../lib/queryKeys";

/** "Mail" tab label with an unread-count badge. */
export function MailTabLabel({ agentId }: { agentId: string }) {
  const { data } = useQuery({
    queryKey: queryKeys.agentMail.folders(agentId),
    queryFn: () => agentEmailApi.folderCounts(agentId),
    refetchInterval: 60_000,
  });
  const unread = data?.inbox ?? 0;
  return (
    <span className="inline-flex items-center gap-1.5">
      Mail
      {unread > 0 && (
        <span className="rounded-full bg-primary px-1.5 text-xs leading-5 text-primary-foreground">{unread}</span>
      )}
    </span>
  );
}
