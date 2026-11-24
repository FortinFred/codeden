import type { AcpExtensionHost } from "../acp/extensions";
import { type AcpToolState, pathsOf } from "../acp/items";
import type { AcpBoundaryAsk } from "../acp/policy";
import { isInside, isInTemp, isInWorkspace, resolveAgainst } from "../policy/paths";
import { str } from "../util/text";

/**
 * The title Copilot CLI gives the permission request it sends before a tool call reaches a path
 * outside the folders it trusts (its read calls themselves are titled "Viewing <path>").
 */
const OUTSIDE_PATHS = "Access paths outside trusted directories";

/**
 * The kind decides what an ask is: a command or an edit is judged as one whatever it is titled,
 * so a spoofed title costs a prompt, never a grant.
 *
 * The session's own artifacts folder (`AcpExtensionHost.artifactsDir`) counts as trusted for
 * reading: that is where CodeDen hands the session its attachments and screenshots, so asking
 * about a file it just supplied would show the user a card for CodeDen's own doing. It is not a
 * write root: only read, search and fetch asks reach here, and edits stay with the policy.
 */
export function copilotBoundaryAsk(
  call: AcpToolState,
  host: Pick<AcpExtensionHost, "cwd" | "extraRoots" | "artifactsDir">,
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
  host: Pick<AcpExtensionHost, "cwd" | "extraRoots" | "artifactsDir">,
): AcpBoundaryAsk | undefined {
  const ctx = { cwd: host.cwd, extraRoots: host.extraRoots };
  const artifacts = host.artifactsDir;
  const paths = pathsOf(call, host.cwd);
  const outside = paths.filter(
    (target) =>
      !isInWorkspace(target, ctx) &&
      !isInTemp(target, ctx) &&
      !(artifacts && isInside(resolveAgainst(target, ctx), artifacts, ctx)),
  );
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
