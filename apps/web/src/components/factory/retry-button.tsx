import { type FactoryRetryMode, type StoppedItem, stoppedRetry } from "@codeden/contracts";
import { Hammer, RotateCcw } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { useRetryItem } from "./use-retry-item";

/**
 * Retry a stopped item (§10.1). Whether it shows, and what it does, come from the shared rule
 * (`stoppedRetry`): for unstuck work with its pull request open, Retry sends that PR back to a
 * fresh review (no new build, no second PR); otherwise (stuck work, no open PR) it is a Rebuild:
 * the work starts over from the first step. Renders nothing for work that hasn't stopped.
 */
export function RetryButton({
  projectId,
  item,
  mode,
  size = "xs",
  variant = "ghost",
  className,
}: {
  projectId: string;
  /** A `FactoryItem` or a panel `FactoryWorkItem`. */
  item: StoppedItem & { id: string };
  mode?: FactoryRetryMode;
  size?: ComponentProps<typeof Button>["size"];
  variant?: ComponentProps<typeof Button>["variant"];
  className?: string;
}) {
  const retry = useRetryItem(projectId, item.id, mode);
  const can = stoppedRetry(item);
  if (!can) return null;
  const pr = can.pr;
  // The shared default when no mode is given: stuck work and work without a PR rebuild.
  const rebuild = (mode ?? can.mode) === "rebuild";
  const title =
    rebuild || !pr
      ? `Run it again from the first step${pr ? `, replacing #${pr.number}` : ""}`
      : `Send #${pr.number} back to a fresh review of its latest commits (no new build)`;
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      title={title}
      disabled={retry.isPending}
      data-testid={rebuild ? "factory-rebuild" : "factory-retry"}
      onClick={(e) => {
        // Inside a link or a card: retry without opening the item.
        e.preventDefault();
        e.stopPropagation();
        retry.mutate();
      }}
    >
      {rebuild ? <Hammer /> : <RotateCcw />}
      {rebuild ? "Rebuild" : "Retry"}
    </Button>
  );
}
