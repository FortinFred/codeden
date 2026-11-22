import type { ForgeConnectionStatus } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useClient } from "@/lib/api";
import { useSnapshotData } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { SettingRow, SettingsSection } from "./settings-ui";

/** The status states of `docs/forges.md` §6.1, for the card's label and tests. */
type ForgeState = "not_configured" | "no_token" | "connected" | "unknown_viewer" | "error";

const stateOf = (status: ForgeConnectionStatus | null): ForgeState => {
  if (!status) return "not_configured";
  if (status.connected) return status.login ? "connected" : "unknown_viewer";
  if (!status.baseUrl) return "not_configured";
  return status.message?.toLowerCase().includes("access token") ? "no_token" : "error";
};

const stateLabel = (status: ForgeConnectionStatus | null): string => {
  if (!status) return "Checking…";
  if (status.connected) {
    const version = status.version ? ` on Forgejo ${status.version}` : "";
    return status.login
      ? `Connected as ${status.login}${version}`
      : `${status.message ?? "Connected"}${version}`;
  }
  return status.message ?? "Not connected";
};

/** GitHub is phase 1; a self-hosted Forgejo is the second forge (`docs/forges.md` §6.1). */
export function ForgesSettings() {
  const client = useClient();
  const queryClient = useQueryClient();
  const saved = useSnapshotData((s) => s.settings.forges.forgejo, null);
  const forges = useQuery({ queryKey: ["forges"], queryFn: () => client.forges.list() });
  const listed = forges.data?.forges.find((f) => f.provider === "forgejo") ?? null;
  const [baseUrl, setBaseUrl] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const [token, setToken] = useState("");
  const [result, setResult] = useState<ForgeConnectionStatus | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // The saved connection fills the form; an empty one is the card's starting point. The status
  // also carries the saved URL, which is enough when settings have not arrived yet.
  const listedUrl = listed?.baseUrl ?? null;
  const savedUrl = saved?.baseUrl ?? null;
  const savedSshHost = saved?.sshHost ?? null;
  const savedAllowInsecureHttp = saved?.allowInsecureHttp ?? false;
  useEffect(() => {
    if (savedUrl) {
      setBaseUrl(savedUrl);
      setSshHost(savedSshHost ?? "");
      setAllowInsecureHttp(savedAllowInsecureHttp);
    } else if (listedUrl) {
      setBaseUrl(listedUrl);
    }
  }, [savedUrl, savedSshHost, savedAllowInsecureHttp, listedUrl]);

  // Only a saved connection can be disconnected: a test result is just a status.
  const configured = Boolean(saved ?? listed?.baseUrl);
  const shown = result ?? listed;
  const state = stateOf(shown);
  const values = () => ({
    baseUrl: baseUrl.trim(),
    ...(sshHost.trim() ? { sshHost: sshHost.trim() } : {}),
    allowInsecureHttp,
  });
  const failed = (e: Error): ForgeConnectionStatus => ({
    provider: "forgejo",
    connected: false,
    baseUrl: baseUrl.trim() || null,
    host: null,
    login: null,
    message: e.message,
    version: null,
  });
  // Saved/removed statuses are authoritative: keep the list in step without another request.
  const remember = (status: ForgeConnectionStatus) =>
    queryClient.setQueryData(["forges"], { forges: [status] });

  const test = useMutation({
    mutationFn: () =>
      client.forges.testForgejo({ ...values(), ...(token.trim() ? { token: token.trim() } : {}) }),
    onSuccess: (status) => setResult(status),
    onError: (e) => setResult(failed(e)),
  });
  const save = useMutation({
    mutationFn: () =>
      client.forges.saveForgejo({ ...values(), ...(token.trim() ? { token: token.trim() } : {}) }),
    onSuccess: (status) => {
      setResult(status);
      remember(status);
      setToken("");
      toast.success(status.connected ? "Forgejo connection saved" : "Forgejo settings saved", {
        description: status.message ?? undefined,
      });
    },
    onError: (e) => toast.error("Forgejo connection not saved", { description: e.message }),
  });
  const remove = useMutation({
    mutationFn: () => client.forges.removeForgejo(),
    onSuccess: (status) => {
      setResult(status);
      remember(status);
      setToken("");
      toast.success("Forgejo disconnected", {
        description: "Its configuration and token were removed from CodeDen.",
      });
    },
    onError: (e) => toast.error("Couldn't disconnect Forgejo", { description: e.message }),
  });

  const statusTone =
    state === "connected"
      ? "text-status-done"
      : state === "error"
        ? "text-status-failed"
        : "text-status-waiting";
  const warning = allowInsecureHttp || baseUrl.trim().toLowerCase().startsWith("http://");

  return (
    <SettingsSection
      title="Forges"
      description="CodeDen reads issues and pull requests from the project's forge. GitHub is built in; a self-hosted Forgejo instance is connected here with a token kept in the OS keychain."
    >
      <SettingRow
        label="Forgejo"
        help="One self-hosted Forgejo instance (Gitea-compatible API v1)."
        stacked
      >
        <div className="flex flex-wrap items-center gap-2" data-testid="forgejo-connection">
          <span
            className={cn("inline-flex items-center gap-1 text-xs", statusTone)}
            data-testid="forgejo-status"
            data-state={state}
          >
            {state === "connected" ? (
              <CheckCircle2 className="size-3.5" />
            ) : (
              <CircleAlert className="size-3.5" />
            )}
            {stateLabel(shown)}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => test.mutate()}
            disabled={test.isPending || !baseUrl.trim()}
          >
            <RefreshCw className={cn(test.isPending && "animate-spin")} />
            {test.isPending ? "Testing…" : "Test connection"}
          </Button>
        </div>
      </SettingRow>
      <SettingRow label="URL" help="The forge's web root, with no path." stacked>
        <Input
          aria-label="Forgejo URL"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://forge.example.com"
          className="h-8 font-mono text-xs"
        />
      </SettingRow>
      <SettingRow
        label="SSH host (optional)"
        help="The host (and optional port) a project's ssh:// or git@ origin may use, e.g. git.example.com:2222. Only needed when it differs from the URL's host."
        stacked
      >
        <Input
          aria-label="Forgejo SSH host"
          value={sshHost}
          onChange={(e) => setSshHost(e.target.value)}
          placeholder="forge.example.com:2222"
          className="h-8 font-mono text-xs"
        />
      </SettingRow>
      <SettingRow
        label="Allow plain HTTP"
        help="Loopback and private addresses may use http:// anyway. A public host needs this explicit opt-in."
      >
        <div className="flex flex-col items-end gap-1">
          <Switch
            aria-label="Allow plain HTTP"
            checked={allowInsecureHttp}
            onCheckedChange={setAllowInsecureHttp}
          />
          {warning && (
            <p className="max-w-56 text-right text-2xs leading-relaxed text-status-waiting">
              The token travels unencrypted on this network. Use HTTPS unless this is a loopback or
              private address.
            </p>
          )}
        </div>
      </SettingRow>
      <SettingRow
        label="Access token"
        help="Write-only. It is stored in the OS keychain and never shown again. Create one in Forgejo under Settings → Applications, with read:repository, write:repository, read:issue and read:user."
        stacked
      >
        <Input
          type="password"
          autoComplete="off"
          aria-label="Forgejo access token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={
            configured
              ? "•••••••• stored in the OS keychain"
              : "Paste a token to store it in the keychain"
          }
          className="h-8 font-mono text-xs"
        />
      </SettingRow>
      <SettingRow
        label="Save the connection"
        help="CodeDen tests it with GET /version and GET /user, then keeps the URL, optional SSH host and token."
        stacked
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => save.mutate()}
            disabled={save.isPending || !baseUrl.trim()}
            data-testid="forgejo-save"
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          {configured && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmDisconnect(true)}
              disabled={remove.isPending}
            >
              Disconnect
            </Button>
          )}
        </div>
      </SettingRow>
      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Forgejo?</AlertDialogTitle>
            <AlertDialogDescription>
              CodeDen removes the connection and its token from the OS keychain. Projects and their
              git remotes are untouched; a forge project keeps its coordinates and can be
              disconnected from its project page. Synced issues and pull requests, if any, are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
