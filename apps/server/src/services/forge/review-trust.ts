import type { ForgePermission, GithubReview } from "@codeden/contracts";

/**
 * Whose pull request reviews may steer an agent on a forge project (`docs/forges.md` §6.2).
 * GitHub uses `authorAssociation`; Forgejo has no such field, so trust comes from, in order:
 *
 * 1. a live collaborator permission of `write` or `admin` (the owner's own login is `owner`);
 * 2. the review's `official` flag, which Forgejo sets when the review counts for the branch's
 *    required approvals (a fallback for a token that cannot read permissions);
 * 3. the account CodeDen reads the forge with (`viewer`, stamped on `review.submitted`); or
 * 4. one of the project's `trustedAuthors`.
 *
 * `unknown` is not write access: a permission lookup that cannot answer (403, 5xx, timeout)
 * trusts nobody by itself, and the other signals decide. Anything else is untrusted input data,
 * and its body is never passed to an agent.
 */
export function isTrustedForgeReview(input: {
  review: Pick<GithubReview, "author" | "official">;
  permission: ForgePermission;
  viewer: string | null;
  trustedAuthors: readonly string[];
}): boolean {
  if (input.permission === "owner" || input.permission === "write") return true;
  if (input.review.official === true) return true;
  const login = (input.review.author ?? "").toLowerCase();
  if (!login) return false;
  if (input.viewer && login === input.viewer.toLowerCase()) return true;
  return input.trustedAuthors.some((author) => author.toLowerCase() === login);
}
