import type { Project, RefreshProjectResponse } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { cn } from "@/lib/utils";

const connected = (r: RefreshProjectResponse) =>
  r.outcome === "github_connected" ||
  r.outcome === "github_changed" ||
  r.outcome === "forge_connected" ||
  r.outcome === "forge_changed";

/**
 * Detect a project's git checkout and GitHub remote again (§9): for a folder that got `git init`
 * or a GitHub `origin` after it was added. The project itself updates through the snapshot;
 * the result line ("Connected to owner/repo", "Still no GitHub remote on origin") shows next to
 * the button, and a toast confirms a new connection (the button's view usually goes away then).
 */
export function CheckRemoteButton({
  projectId,
  layout = "stacked",
  className,
}: {
  projectId: string;
  /** `stacked`: centred under the button (empty states); `inline`: on one line (lists). */
  layout?: "stacked" | "inline";
  className?: string;
}) {
  const client = useClient();
  const check = useMutation({
    mutationFn: () => client.refreshProject(projectId),
    onSuccess: (res) => {
      if (connected(res) && res.changed) toast.success(res.message);
    },
  });
  const result = check.data;
  const text = check.isError ? `Couldn't check: ${check.error.message}` : result?.message;
  return (
    <span
      className={cn(
        "flex gap-1.5",
        layout === "stacked" ? "flex-col items-center" : "flex-wrap items-center",
        className,
      )}
    >
      <Button
        size="xs"
        variant="outline"
        onClick={() => check.mutate()}
        disabled={check.isPending}
        data-testid="check-remote"
      >
        <RefreshCw className={cn(check.isPending && "animate-spin")} />
        {check.isPending ? "Checking…" : "Check again"}
      </Button>
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "text-2xs",
          check.isError
            ? "text-status-failed"
            : result && connected(result)
              ? "text-status-done"
              : "text-muted-foreground",
        )}
      >
        {text}
      </span>
    </span>
  );
}

/**
 * A GitHub or forge project whose folder lost its matching `origin` (§9, `docs/forges.md` §7):
 * CodeDen never downgrades it on its own. The user restores the remote and checks again, or
 * disconnects the forge and makes the project local-only.
 */
export function RemoteWarningBanner({ project }: { project: Project }) {
  const client = useClient();
  const forge = project.kind === "forge";
  const disconnect = useMutation({
    mutationFn: () =>
      forge ? client.disconnectForge(project.id) : client.disconnectGithub(project.id),
    onSuccess: () => toast.success(`${project.name} is now a local-only project`),
    onError: (e) =>
      toast.error(forge ? "Couldn't disconnect the forge" : "Couldn't disconnect GitHub", {
        description: e.message,
      }),
  });
  if (!project.remoteWarning) return null;
  if (project.kind === "github") {
    const { owner, repo } = project.github;
    const { remoteUrl } = project.remoteWarning;
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-xl border border-status-waiting/30 bg-status-waiting/10 px-4 py-3"
        data-testid="remote-warning"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-waiting" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[13px] font-medium">The GitHub remote is missing</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {remoteUrl ? (
              <>
                <code className="font-mono">origin</code> now points to{" "}
                <code className="font-mono">{remoteUrl}</code>
              </>
            ) : (
              <>
                This folder has no GitHub <code className="font-mono">origin</code> any more
              </>
            )}
            , so CodeDen still uses {owner}/{repo} for issues and pull requests. Restore the remote
            and check again, or make the project local-only (synced issues and PRs are kept).
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <CheckRemoteButton projectId={project.id} layout="inline" />
            <Button
              size="xs"
              variant="ghost"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              Make local-only
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (project.kind !== "forge" || project.remoteWarning.code !== "forge_remote_missing") {
    return null;
  }
  const { owner, repo, host } = project.forge;
  const { remoteUrl } = project.remoteWarning;
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-status-waiting/30 bg-status-waiting/10 px-4 py-3"
      data-testid="remote-warning"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-waiting" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-[13px] font-medium">The Forgejo remote is missing</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {remoteUrl ? (
            <>
              <code className="font-mono">origin</code> now points to{" "}
              <code className="font-mono">{remoteUrl}</code>
            </>
          ) : (
            <>
              This folder has no matching Forgejo <code className="font-mono">origin</code> any more
            </>
          )}
          , so CodeDen still uses {owner}/{repo} on {host}. Restore the remote and check again, or
          disconnect the forge (the project becomes local-only; synced issues and PRs are kept).
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <CheckRemoteButton projectId={project.id} layout="inline" />
          <Button
            size="xs"
            variant="ghost"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
          >
            Disconnect forge
          </Button>
        </div>
      </div>
    </div>
  );
}
