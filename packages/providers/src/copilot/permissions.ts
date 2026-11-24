import type { AcpExtensionHost } from "../acp/extensions";
import { type AcpToolState, pathsOf } from "../acp/items";
import type { AcpBoundaryAsk } from "../acp/policy";
import { isInTemp, isInWorkspace } from "../policy/paths";
import { str } from "../util/text";

/**
 * The title Copilot CLI gives the permission request it sends before a tool call reaches a path
 * outside the folders it trusts (its read calls themselves are titled "Viewing <path>").
 */
const OUTSIDE_PATHS = "Access paths outside trusted directories";

/**
 * Copilot's own asks, which CodeDen's policy would otherwise grant outright.
 *
 * Its file access stops at the session's folder, the folders it was given and the system temp,
 * and it asks before reaching past that: a read or a search ask titled as above, or one naming a
 * path outside those folders. CodeDen's classifier allows reads and searches anywhere, so the ask
 * would otherwise be granted by policy, silently widening what the session reaches past Copilot's
 * own rule (and the user's Copilot settings).
 *
 * It also asks before it fetches a URL, and a session sets no host allow list, so the policy's
 * fetch classifier allows every URL it names. The ask becomes the user's decision too.
 *
 * The kind decides what an ask is: a command or an edit is judged as one whatever it is titled,
 * so a spoofed title costs a prompt, never a grant.
 */
export function copilotBoundaryAsk(
  call: AcpToolState,
  host: Pick<AcpExtensionHost, "cwd" | "extraRoots">,
): AcpBoundaryAsk | undefined {
  if (call.kind === "read" || call.kind === "search") return pathAsk(call, host);
  if (call.kind === "fetch") {
    const url = str(call.rawInput, "url");
    return url ? { action: "network", reason: `Copilot asks to fetch ${url}` } : undefined;
  }
  return undefined;
}

function pathAsk(
  call: AcpToolState,
  host: Pick<AcpExtensionHost, "cwd" | "extraRoots">,
): AcpBoundaryAsk | undefined {
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
