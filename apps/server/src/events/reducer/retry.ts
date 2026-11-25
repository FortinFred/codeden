import type { ErrorInfo, Session, Turn } from "@codeden/contracts";

/** Whether a failure is one a session may wait out rather than fail on (`transient`, `usage_limit`). */
export function holdsForRetry(error: ErrorInfo): boolean {
  return error.kind === "transient" || error.kind === "usage_limit";
}

/**
 * Whether a failed root turn is left for automatic retry to decide (`AutoRetry`): an agent
 * session's turn that failed for a passing reason. The reducer leaves such a session idle with
 * no inbox item; the auto-retry service then either schedules the retry or fails the session the
 * usual way. Only agents are retried that way: a PM or orchestrator's passing failure is held
 * for its own path instead (`holdsQueuedMessages`), and every other failure fails at once. Pure.
 */
export function awaitsRetryDecision(session: Session, error: ErrorInfo): boolean {
  return session.role === "agent" && holdsForRetry(error);
}

/**
 * Whether a role session holds the messages queued behind a failed root turn: a PM or
 * orchestrator whose last root turn failed for a passing reason stays idle with its queue, and
 * its provider-switch or next-use path decides about it. Agents are not held: a message cancels
 * their pending automatic retry, as before. Pure.
 */
export function holdsQueuedMessages(session: Session, turn: Turn | null | undefined): boolean {
  return (
    session.role !== "agent" &&
    turn?.status === "failed" &&
    !!turn.error &&
    holdsForRetry(turn.error)
  );
}
