import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, FileCheck, Hammer, MessageCircleQuestion, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { stoppedKind } from "@/components/factory/stopped-items";
import { useRetryItem } from "@/components/factory/use-retry-item";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";
import { platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { cardNumber, type ViewCard } from "./stages";
import { ViewCardButton } from "./view-card";

/**
 * What a "Needs you" card asks of a person, and the buttons that do it in place: open the pull
 * request to review and merge it, retry or dismiss stopped work, open the agent's session to
 * answer it, or open the item to approve its spec.
 */
export function NeedActions({
  card,
  projectId,
  className,
}: {
  card: ViewCard;
  projectId: string;
  className?: string;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const need = card.need;
  const name = cardNumber(card.item);
  const refresh = () => queryClient.invalidateQueries({ queryKey: factoryKeys.all });
  // Stuck work can only move on by starting over: rebuilding avoids a re-review of a pull
  // request whose checks can never pass (#61).
  const stuck = stoppedKind(card.item, card.pr) === "stuck";
  const retry = useRetryItem(projectId, card.item.id, stuck ? "rebuild" : undefined);
  const dismiss = useMutation({
    mutationFn: () => client.factory.dismiss(projectId, card.item.id),
    // Await the refetch: until the fresh status arrives the stale card still draws these
    // buttons, and a second click would answer `not_failed` / `pr_open` (#69).
    onSuccess: async () => {
      toast.success(`${name} dismissed`);
      await refresh();
    },
    onError: (e) => toast.error("Couldn't dismiss", { description: e.message }),
  });
  if (!need) return null;
  const busy = retry.isPending || dismiss.isPending;
  const prUrl = card.pr?.pr.url ?? card.item.ownedPr?.url ?? card.item.pr?.url ?? null;
  return (
    <div
      className={cn("flex flex-wrap items-center gap-1", className)}
      data-testid="factory-view-need"
      data-need={need.kind}
    >
      <span className="mr-auto min-w-0 text-2xs font-medium text-status-waiting">{need.label}</span>
      {need.kind === "merge" && prUrl && (
        <Button size="xs" variant="outline" onClick={() => platform.openExternal(prUrl)}>
          <ExternalLink /> Open PR
        </Button>
      )}
      {(need.kind === "retry" || need.kind === "retry_or_dismiss") && (
        <Button
          size="xs"
          variant="outline"
          onClick={() => retry.mutate()}
          disabled={busy}
          aria-label={`${stuck ? "Rebuild" : "Retry"} ${name}`}
        >
          {stuck ? <Hammer /> : <RotateCcw />} {stuck ? "Rebuild" : "Retry"}
        </Button>
      )}
      {need.kind === "retry_or_dismiss" && (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => dismiss.mutate()}
          disabled={busy}
          aria-label={`Dismiss ${name}`}
        >
          <X /> Dismiss
        </Button>
      )}
      {need.kind === "answer" && card.sessionId && (
        <Button size="xs" variant="outline" asChild>
          <Link to="/sessions/$sessionId" params={{ sessionId: card.sessionId }}>
            <MessageCircleQuestion /> Answer
          </Link>
        </Button>
      )}
      {need.kind === "approve_spec" && (
        <Button size="xs" variant="outline" asChild>
          <Link
            to="/projects/$projectId/factory/$itemId"
            params={{ projectId, itemId: card.item.id }}
            aria-label={`Review the spec of ${name}`}
          >
            <FileCheck /> Review spec
          </Link>
        </Button>
      )}
    </div>
  );
}

/** A card in the "Needs you" lane: the card (opens its sheet) with what it needs below. */
export function NeedsYouCard({
  card,
  now,
  onOpen,
  projectId,
}: {
  card: ViewCard;
  now: number;
  onOpen: (card: ViewCard) => void;
  projectId: string;
}) {
  return (
    <div className="flex flex-col">
      <ViewCardButton
        card={card}
        now={now}
        onOpen={onOpen}
        className="rounded-b-none border-b-0 shadow-none"
      />
      <NeedActions
        card={card}
        projectId={projectId}
        className={cn(
          "rounded-b-lg border px-2.5 py-1.5",
          card.state === "failed"
            ? "border-status-failed/50 bg-status-failed/[0.05]"
            : "border-status-waiting/50 bg-status-waiting/[0.05]",
        )}
      />
    </div>
  );
}
