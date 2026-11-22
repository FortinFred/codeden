import type { ForgePermission, ForgeRepoInfo } from "@codeden/contracts";
import { ForgeError } from "../../errors";
import { type ForgejoContext, repoPath, seg } from "./context";
import { permissionForLogin, toForgeRepoInfo } from "./map-git";
import type {
  ForgejoPermissionFlags,
  ForgejoRepository,
  ForgejoUser,
  ForgejoVersion,
} from "./types";

/**
 * Identity, version and permissions (`docs/forges.md` §5.1–5.3). A 403 on `/user` is an unknown
 * viewer, not a broken connection; a 403 on a permission lookup is unknown, never `none`.
 */

/** `GET /version`, refusing anything older than Forgejo 15.0. */
export async function version(context: ForgejoContext): Promise<string> {
  const { data } = await context.http.get<ForgejoVersion>("version");
  const value = data?.version?.trim();
  const match = value ? /^v?(\d+)\.(\d+)/.exec(value) : null;
  if (!value || !match) {
    throw new ForgeError(
      "forge_unavailable",
      "Forgejo did not report a version CodeDen can read. Check the base URL.",
    );
  }
  if (Number(match[1]) < 15) {
    throw new ForgeError(
      "forge_not_allowed",
      `Forgejo ${value} is too old; CodeDen needs Forgejo 15.0 or newer.`,
    );
  }
  return value;
}

/** `GET /user`: the token account's login, or null when a specific-repository token has no user scope. */
export async function viewerLogin(context: ForgejoContext): Promise<string | null> {
  try {
    const { data } = await context.http.get<ForgejoUser>("user");
    return data?.login ?? null;
  } catch (error) {
    if (error instanceof ForgeError && error.forgeCode === "forge_forbidden") return null;
    throw error;
  }
}

/** `GET /repos/{owner}/{repo}`: default branch, repository units and the token's permission. */
export async function repoInfo(context: ForgejoContext): Promise<ForgeRepoInfo> {
  const { data } = await context.http.get<ForgejoRepository>(repoPath(context));
  if (!data) throw new ForgeError("forge_unavailable", "Forgejo returned no repository.");
  return toForgeRepoInfo(data);
}

/** A login's live collaborator permission; 404 is none, 403 and server errors are unknown. */
export async function permission(context: ForgejoContext, login: string): Promise<ForgePermission> {
  if (login.toLowerCase() === context.owner.toLowerCase()) return "owner";
  try {
    const { data } = await context.http.get<ForgejoPermissionFlags>(
      `${repoPath(context)}/collaborators/${seg(login)}/permission`,
    );
    return permissionForLogin(login, context.owner, data ?? {});
  } catch (error) {
    if (error instanceof ForgeError) {
      if (error.forgeCode === "forge_not_found") return "none";
      if (
        error.forgeCode === "forge_forbidden" ||
        error.forgeCode === "forge_rate_limited" ||
        error.forgeCode === "forge_unavailable"
      ) {
        return "unknown";
      }
    }
    throw error;
  }
}
