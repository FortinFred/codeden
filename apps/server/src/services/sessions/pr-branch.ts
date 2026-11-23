import type { GitCredential, Session } from "@codeden/contracts";
import { badRequest, conflict } from "../errors";
import { type RunnerDeps, type RunnerPort, runnerForSession, toServiceError } from "../runner-port";
import { ownBranch } from "./own-branch";
import { sessionWorkdir } from "./workdir";

/**
 * Pushing a session's branch for a pull request, shared by GitHub and a forge
 * (`docs/forges.md` §5.5). It is provider-neutral: the branch, the base and the commit are the
 * same everywhere; only the credential differs, and only a sandboxed runner needs one.
 */

const SESSION_MARKER = "<!-- codeden:session=";

/** The PR body: the agent's text, `Fixes #N`, and a footer naming the CodeDen session. */
export function pullRequestBody(text: string, issue: number | null, session: Session): string {
  const parts = [text.trim()];
  if (
    issue &&
    !new RegExp(`\\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\\s+#${issue}\\b`, "i").test(text)
  ) {
    parts.push(`Fixes #${issue}`);
  }
  const label = session.title ? `${session.title} (\`${session.id}\`)` : `\`${session.id}\``;
  parts.push(
    `---\n<sub>Opened by CodeDen session ${label}</sub>\n${SESSION_MARKER}${session.id} -->`,
  );
  return parts.filter(Boolean).join("\n\n");
}

/** git's answer when a push would rewrite the remote branch's history. */
const NOT_FAST_FORWARD = /\((non-fast-forward|fetch first)\)|updates were rejected/i;

/**
 * Push the session's branch. When the session owns it (its own worktree's branch) and the push
 * is rejected as not a fast-forward, as after a rebase, push again with a lease: that rewrites
 * only the session's own work, and refuses if someone else pushed there since.
 */
async function pushBranch(
  runner: RunnerPort,
  session: Session,
  cwd: string,
  branch: string,
  credential: GitCredential | undefined,
): Promise<void> {
  const push = {
    name: "git.push",
    cwd,
    branch,
    setUpstream: true,
    ...(credential ? { credential } : {}),
  } as const;
  try {
    await runner.request(push, 5 * 60_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ownBranch(session) !== branch || !NOT_FAST_FORWARD.test(message)) throw error;
    await runner.request({ ...push, forceWithLease: true }, 5 * 60_000);
  }
}

export interface PrepareBranchDeps extends RunnerDeps {
  /**
   * A credential for this push, for a runner that does not share the server's disk (§9.2).
   * Absent for the home runner, which uses the user's own git setup.
   */
  credentialFor?: (runner: RunnerPort) => Promise<GitCredential | undefined>;
}

export interface BranchInput {
  /** Target branch; default the session's base branch, then the repository default. */
  base?: string;
  /** Commit uncommitted changes with this message before pushing. */
  commitMessage?: string;
}

/**
 * Commit what the session left uncommitted (when asked), then push its branch (see
 * `pushBranch`). Returns the branch and base the pull request must use.
 */
export async function prepareSessionBranch(
  deps: PrepareBranchDeps,
  session: Session,
  defaultBranch: string,
  input: BranchInput,
): Promise<{ branch: string; base: string; commit: string | null }> {
  const cwd = sessionWorkdir(session);
  const branch = session.branch;
  if (!branch)
    throw conflict("This session has no branch to open a pull request from", "no_branch");
  const base = input.base ?? session.baseBranch ?? defaultBranch;
  if (branch === base) {
    throw conflict(
      `The session works on ${base} itself; a pull request needs its own branch`,
      "same_branch",
    );
  }

  let commit: string | null = null;
  const runner = runnerForSession(deps, session.id);
  try {
    const status = await runner.request({ name: "git.status", cwd }, 30_000);
    if (status.files.length > 0) {
      if (!input.commitMessage) {
        throw badRequest(
          `There are ${status.files.length} uncommitted change(s). Commit them first or pass commitMessage.`,
          "uncommitted_changes",
        );
      }
      commit = (
        await runner.request({ name: "git.commit", cwd, message: input.commitMessage }, 5 * 60_000)
      ).commit;
    }
    // A runner in a sandbox gets the token for this push only (§9.2); others use their own git.
    const credential = await deps.credentialFor?.(runner);
    await pushBranch(runner, session, cwd, branch, credential);
  } catch (error) {
    throw toServiceError(error);
  }
  return { branch, base, commit };
}
