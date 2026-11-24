import type { AcpExtensionHost } from "../acp/extensions";
import { type AcpToolState, pathsOf } from "../acp/items";
import type { AcpBoundaryAsk } from "../acp/policy";
import { isInTemp, isInWorkspace } from "../policy/paths";

/**
 * The title Copilot CLI gives the permission request it sends before a tool call reaches a path
 * outside the folders it trusts (its tool call itself is titled "Viewing <path>").
 */
const OUTSIDE_PATHS = "Access paths outside trusted directories";

/**
 * Copilot's own path ask. Its file access stops at the session's folder, the folders it was
 * given and the system temp directory, and it asks before reaching past that: a read ask titled
 * as above, or one naming a path outside those folders. CodeDen's classifier allows reads
 * anywhere, so the ask would otherwise be granted by policy, silently widening what the session
 * reaches past Copilot's own rule (and the user's Copilot settings). Only a read ask becomes
 * one: a command or an edit is judged as one whatever it is titled, so a spoofed title costs a
 * prompt, never a grant.
 */
export function copilotPathAsk(
  call: AcpToolState,
  host: Pick<AcpExtensionHost, "cwd" | "extraRoots">,
): AcpBoundaryAsk | undefined {
  if (call.kind !== "read") return undefined;
  const ctx = { cwd: host.cwd, extraRoots: host.extraRoots };
  const paths = pathsOf(call, host.cwd);
  const outside = paths.filter((target) => !isInWorkspace(target, ctx) && !isInTemp(target, ctx));
  if (outside.length) return { action: "outside_worktree", reason: reasonFor(outside) };
  // The paths CodeDen can read say the call stays in its own folders (the worktree, a folder the
  // session was given, temp): Copilot asks because it doesn't know the extra folders, not because
  // the call leaves what this session may reach. Without a path to judge, its own title decides.
  const titled = (call.title ?? "").trim().toLowerCase() === OUTSIDE_PATHS.toLowerCase();
  if (!titled || paths.length) return undefined;
  return { action: "outside_worktree", reason: reasonFor([]) };
}

function reasonFor(paths: readonly string[]): string {
  if (paths.length === 1) {
    return `Copilot asks to reach ${paths[0]}, outside the folders this session trusts`;
  }
  if (paths.length > 1) {
    return `Copilot asks to reach ${paths.length} paths outside the folders this session trusts`;
  }
  return "Copilot asks to reach a path outside the folders this session trusts";
}
