# Forgejo

A project whose `origin` is a self-hosted **Forgejo** repository can use the same issues, pull requests, evidence, review feedback and software factory as a GitHub project. GitHub stays the default; connecting Forgejo is opt-in and capability-gated, so features Forgejo cannot offer are refused clearly instead of pretending.

## Connecting

1. Create a token in Forgejo under **Settings → Applications → Generate New Token**, with `read:repository`, `write:repository`, `read:issue`, `write:issue` and `read:user`.
2. Open **Settings → Forges → Forgejo**, enter the instance's web URL (for example `https://forge.example.com` or `http://localhost:3000`), optionally an SSH host, and paste the token. **Test connection** reports the token's login and the Forgejo version.
3. Add a project whose `origin` matches that instance. Its page says **Forgejo repository** and shows the host, owner and repository.

The token is stored in the OS keychain as `forgejo.token`; it is never written to the project, events, logs, transcripts or an agent's environment. Use a dedicated bot account added as a collaborator, so what CodeDen may do is limited by the account, not the token. Plain HTTP is accepted for a loopback or private address with a warning that the token travels unencrypted; a public host needs HTTPS unless you explicitly allow insecure HTTP.

A folder is connected only when its remote matches the configured instance exactly (web origin, or the SSH host you set). CodeDen never guesses a forge from a hostname. If the remote disappears the project keeps its coordinates and warns; **Disconnect forge** makes it local-only, and switching to or from GitHub is your choice, never automatic.

## Issues and pull requests

- The project's issue and PR view lists what CodeDen syncs from Forgejo: state filters, labels, checks and review state.
- The PM and agents can create issues, comment, add or remove labels and close issues. Labels are resolved by name; an unknown one is dropped and logged rather than guessed. Forgejo has no `state_reason`, so a closed issue never claims a reason and CodeDen does not treat "closed" as "completed".
- An agent session opens its pull request with `create_pull_request`, which pushes the session's branch and opens (or updates) the PR with its marker and `Fixes #N` link. **Draft pull requests are refused** with `draft_unsupported`, because Forgejo's API cannot create them; open the PR ready instead.
- When a session's PR fails its commit statuses, gets a trusted review that requests changes, or starts conflicting, the session's agent gets the same feedback message GitHub sessions get. A review counts only when its author has live write access, is marked `official`, is the account CodeDen reads the forge with, or is a trusted author.

## The software factory

The software factory and the dark factory run on a forge project with the same loop, merge checks, merge queue, trust rules and limits as on GitHub. CodeDen reads **commit statuses**, never Actions internals: a warning or an error is red, and a pull request with no statuses is never green. A merge is pinned to the head the approval covers; a moved head or a refused merge style is a refusal the queue counts. CI that can never run is reported as such, instead of waiting forever.

Evidence works:

- `attach_evidence` posts screenshots, files and test output as **issue/PR attachments**, in the same comment GitHub gets: the heading, images inline, captions and a collapsed **Test output** section. URLs are absolute, so they render on the forge.
- If attachments are disabled on the instance, or a file exceeds its limits, the file is committed through the Contents API to a normal **`codeden/evidence`** branch instead and linked as `/<owner>/<repo>/raw/branch/codeden/evidence/<path>`. There is no orphan branch, because Forgejo has no Git Data write API.
- The factory requires screenshots for UI changes again, and test results from attached test output or a `## Test results` section. It reads only CodeDen's own evidence comments: anyone can comment on a public repository, so a comment by another account is ignored.
- Secrets files (`.env`, keys, `.npmrc`, ...) and CodeDen's own credential files are refused before any upload or commit, by path, name or artifact id, exactly as on GitHub. CodeDen's own Markdown viewer still fetches remote images only from public addresses, so a private or `localhost` forge image renders on the forge page and shows as a link in CodeDen.

The vision editor's **Review & save** shares the vision through a small **`codeden/vision`** pull request, committed one file at a time through the Contents API. Saving the same text again adds nothing; an open vision PR is updated, and a stale branch from a closed or merged vision PR is reset from the default branch. The vision is still saved in the main checkout either way.

## Limitations

- **No draft pull requests.** `create_pull_request` refuses `draft: true` with `draft_unsupported`.
- **No close reason.** Forgejo has no `state_reason`; CodeDen leaves it empty and never reads a closed issue as completed.
- **Reverts are written by an agent.** Forgejo has no revert API (no Git Data write API), so the factory's fallback opens the revert pull request as an agent instead of building a tree/commit/ref.
- **No sandboxed push yet.** A forge project's sessions run on the home runner. Pushing from a sandboxed or remote runner to a self-hosted forge is not supported yet, because a container cannot reach the host's `localhost`.
- **One connection.** CodeDen connects to one Forgejo instance at a time. More instances would need a connection id per token; the settings do not pretend otherwise.
- **Check runs, merge state and `state_reason` are absent.** CodeDen reads commit statuses and Forgejo's boolean `mergeable`; `mergeState` stays `unknown`. Other CI (Woodpecker, Drone, a script) surfaces through the same commit statuses.
- **Polling, not webhooks.** A local CodeDen cannot receive webhooks. Forgejo's API has no ETags or GraphQL, so the sync polls with an updated cursor. `CODEDEN_*` polling intervals are the same as GitHub's.
- **An unknown viewer is not trusted.** A repository-only token cannot call `/user`; intake then takes only trusted authors, reviews rely on `official` or live write access, and the project says why.

## Troubleshooting

- **The Forgejo connection is not connected.** Re-check the URL and token; a 401 means the token was rejected. A repository-only token may connect but cannot read its own login.
- **Issues or PRs look stale.** Open the project's issue/PR view and press **Sync**, or wait for the poll. Check the server log for a `forge:` line; it never contains the token.
- **A merge does not happen.** Check the item's checks: commit statuses must pass, a trusted approval must cover the current head, and the forge must accept the squash merge. A moved head or branch protection is a refusal, not a retry.
- **Evidence shows as a link in CodeDen.** That is the public-only remote-image guard; the image renders on the forge page. The link itself is the evidence.
- **A UI change waits for screenshots.** The factory requires them again. Attach a screenshot with `attach_evidence`; browser screenshots can go straight in from `browser_screenshot`.

The full Forgejo mapping, including the exact API calls and the capability gate for every feature, is in [forges.md](forges.md).
