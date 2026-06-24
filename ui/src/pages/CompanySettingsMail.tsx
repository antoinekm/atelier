import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Inbox, Loader2, Plus, Trash2 } from "lucide-react";
import type { MailAddress, MailDomain } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { mailApi } from "../api/mail";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SHARED = "__shared__";

export function CompanySettingsMail() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [domainId, setDomainId] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [owner, setOwner] = useState<string>(SHARED);

  useEffect(() => {
    setBreadcrumbs([{ label: "Mail" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId;

  const domainsQuery = useQuery({
    queryKey: companyId ? queryKeys.mail.domains(companyId) : ["mail", "domains", "none"],
    queryFn: () => mailApi.listDomains(companyId!),
    enabled: Boolean(companyId),
  });
  const addressesQuery = useQuery({
    queryKey: companyId ? queryKeys.mail.addresses(companyId) : ["mail", "addresses", "none"],
    queryFn: () => mailApi.listAddresses(companyId!),
    enabled: Boolean(companyId),
  });
  const agentsQuery = useQuery({
    queryKey: ["agents", companyId],
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId),
  });

  const toastError = (e: unknown, fallback: string) =>
    pushToast({ tone: "error", title: e instanceof ApiError ? e.message : fallback });

  const createMutation = useMutation({
    mutationFn: () =>
      mailApi.createAddress(companyId!, {
        domainId,
        localPart: localPart.trim(),
        agentId: owner === SHARED ? null : owner,
      }),
    onSuccess: (address) => {
      setLocalPart("");
      pushToast({ tone: "success", title: `${address.address} created` });
      queryClient.invalidateQueries({ queryKey: queryKeys.mail.addresses(companyId!) });
    },
    onError: (e) => toastError(e, "Failed to create address"),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => mailApi.removeAddress(companyId!, id),
    onSuccess: () => {
      pushToast({ tone: "success", title: "Address deleted" });
      queryClient.invalidateQueries({ queryKey: queryKeys.mail.addresses(companyId!) });
    },
    onError: (e) => toastError(e, "Failed to delete address"),
  });

  if (!companyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company.</div>;
  }

  const domains = (domainsQuery.data ?? []).filter((d) => d.status !== "failed");
  const addresses = addressesQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const agentName = (id: string | null) => (id ? agents.find((a) => a.id === id)?.name ?? "agent" : null);
  const receptionReady = domains.some((d: MailDomain) => d.mxConfigured);
  const canCreate = Boolean(domainId && localPart.trim()) && !createMutation.isPending;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Mail</h1>
        <p className="text-sm text-muted-foreground">
          Create the mailboxes your agents use on the attached domains. Connect Cloudflare and attach
          domains under Domain first.
        </p>
      </div>

      <div
        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
          receptionReady ? "text-emerald-600" : "text-muted-foreground"
        }`}
      >
        <Inbox className="h-4 w-4" />
        {receptionReady
          ? "Reception is wired: at least one domain has its MX published."
          : "No domain has its MX published yet. Attach/verify a domain under Domain (the server needs MAIL_HOSTNAME set)."}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AtSign className="h-4 w-4" /> New address
          </CardTitle>
          <CardDescription>
            Pick a domain, a local part (or <code className="rounded bg-muted px-1">*</code> for a
            catch-all), and who owns it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {domains.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No domains attached. Attach one under Domain first.
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select value={domainId} onValueChange={setDomainId}>
                  <SelectTrigger className="sm:w-56">
                    <SelectValue placeholder="Domain" />
                  </SelectTrigger>
                  <SelectContent>
                    {domains.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.domain}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="sm:flex-1"
                  placeholder="local part (e.g. ceo, or *)"
                  value={localPart}
                  onChange={(e) => setLocalPart(e.target.value)}
                />
                <Select value={owner} onValueChange={setOwner}>
                  <SelectTrigger className="sm:w-56">
                    <SelectValue placeholder="Owner" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SHARED}>Shared (no owner)</SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button className="self-start" disabled={!canCreate} onClick={() => createMutation.mutate()}>
                {createMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Create address
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Addresses</CardTitle>
          <CardDescription>All mailboxes on the company's domains.</CardDescription>
        </CardHeader>
        <CardContent>
          {addressesQuery.isError ? (
            <div className="text-sm text-destructive">Failed to load addresses.</div>
          ) : addresses.length === 0 ? (
            <div className="text-sm text-muted-foreground">No addresses yet.</div>
          ) : (
            <div className="overflow-hidden rounded-md border">
              {addresses.map((address: MailAddress) => (
                <div
                  key={address.id}
                  className="flex items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0"
                >
                  <span className="font-mono">{address.address}</span>
                  {address.kind === "catch_all" && <Badge variant="secondary">catch-all</Badge>}
                  <span className="ml-auto text-muted-foreground">
                    {agentName(address.agentId) ?? "shared"}
                  </span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={removeMutation.isPending}
                    title="Delete address"
                    onClick={() => removeMutation.mutate(address.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
