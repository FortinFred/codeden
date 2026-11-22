import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  ForgejoSettings,
  ForgeRepo,
  PackageManager,
  ProjectDetection,
} from "@codeden/contracts";
import { badRequest } from "../errors";
import type { Exec } from "../exec";
import { validateForgejoBaseUrl } from "../forge/forgejo/base-url";
import { parseForgejoSshHost } from "../forge/forgejo/ssh-host";

/** Remove credentials embedded in URLs (`https://user:token@host`). */
export function redactUrls(text: string): string {
  return text.replace(/(\w+:\/\/)[^@\s/]+@/g, "$1***@");
}

/** `owner/repo` from a GitHub remote URL (https, ssh or scp-style); null for other hosts. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(trimmed);
    if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] };
  }
  return null;
}

/** The repository part of a remote that matches a configured Forgejo connection. */
export interface ForgejoRemoteMatch {
  /** The connection's canonical web base, no trailing slash. */
  baseUrl: string;
  /** The host the remote uses: the web host, or the configured SSH host. */
  host: string;
  owner: string;
  repo: string;
}

/**
 * Match a remote URL against the configured Forgejo connections (`docs/forges.md` §7).
 * Only an exact web scheme/host/port and `/<owner>/<repo>` path (for a connection served under a
 * path prefix, that prefix followed by `/<owner>/<repo>`) matches, or an SSH remote whose host
 * equals the connection's explicit `sshHost`. Nothing is guessed from a hostname; a remote that
 * matches more than one connection is left to the user. Returns every match, in configuration
 * order, without duplicates.
 */
export function matchForgejoRemote(
  remoteUrl: string,
  connections: readonly ForgejoSettings[],
): ForgejoRemoteMatch[] {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return [];
  const web = parseWebRemote(trimmed);
  const ssh = web ? null : parseSshRemote(trimmed);
  if (!web && !ssh) return [];

  const matches: ForgejoRemoteMatch[] = [];
  const seen = new Set<string>();
  for (const connection of connections) {
    let base: ReturnType<typeof validateForgejoBaseUrl>;
    try {
      base = validateForgejoBaseUrl(connection.baseUrl, connection);
    } catch {
      continue; // A broken stored connection never matches; the settings page reports it.
    }
    let match: ForgejoRemoteMatch | null = null;
    if (web) {
      if (web.origin !== base.origin) continue;
      const prefix = new URL(base.baseUrl).pathname.replace(/\/+$/, "");
      const coords = repoFromPath(web.pathname, prefix);
      if (coords) match = { baseUrl: base.baseUrl, host: base.host, ...coords };
    } else if (ssh) {
      const rawSshHost = connection.sshHost;
      const sshHost = rawSshHost ? parseForgejoSshHost(rawSshHost) : null;
      if (!sshHost || !sameHost(ssh.host, sshHost.host)) continue;
      if (!sameSshPort(ssh.port, sshHost.port)) continue;
      const coords = repoFromPath(ssh.path, "");
      if (coords && rawSshHost) {
        match = { baseUrl: base.baseUrl, host: rawSshHost, ...coords };
      }
    }
    if (!match) continue;
    const key = `${match.baseUrl}\u0000${match.host.toLowerCase()}\u0000${match.owner}\u0000${match.repo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(match);
  }
  return matches;
}

interface WebRemote {
  origin: string;
  pathname: string;
}

function parseWebRemote(url: string): WebRemote | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.search || parsed.hash) return null;
  return { origin: parsed.origin, pathname: parsed.pathname };
}

interface SshRemote {
  host: string;
  /** Explicit port, or null for the SSH default. */
  port: number | null;
  path: string;
}

function parseSshRemote(url: string): SshRemote | null {
  if (/^ssh:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "ssh:") return null;
    if (parsed.search || parsed.hash || parsed.password) return null;
    if (parsed.username && parsed.username.toLowerCase() !== "git") return null;
    return { host: parsed.hostname, port: portOf(parsed.port), path: parsed.pathname };
  }
  const scp = /^git@(\[[^\]]+\]|[^:\s/]+):(.+)$/i.exec(url);
  if (!scp?.[1] || !scp[2]) return null;
  return { host: scp[1], port: null, path: scp[2] };
}

function portOf(value: string): number | null {
  if (!value) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function sameHost(a: string, b: string): boolean {
  const clean = (value: string) => value.replace(/^\[|\]$/g, "").toLowerCase();
  return clean(a) === clean(b);
}

function sameSshPort(remote: number | null, configured: number | null): boolean {
  // No port means the SSH default (22); a configured host without a port is the same thing.
  return (remote ?? 22) === (configured ?? 22);
}

/**
 * `owner/repo` from a remote path, optionally under a web base path prefix. The repository may
 * end in `.git` and the path in a slash; deeper paths (a file or branch URL) never match.
 */
function repoFromPath(pathname: string, prefix: string): { owner: string; repo: string } | null {
  const path = pathname.replace(/\/+$/, "");
  let remainder: string;
  if (prefix) {
    if (!path.startsWith(`${prefix}/`)) return null;
    remainder = path.slice(prefix.length + 1);
  } else {
    remainder = path.replace(/^\/+/, "");
  }
  const parts = remainder.split("/");
  if (parts.length !== 2) return null;
  let [owner, repo] = parts;
  if (!owner || !repo) return null;
  try {
    owner = decodeURIComponent(owner);
    repo = decodeURIComponent(repo);
  } catch {
    return null;
  }
  repo = repo.replace(/\.git$/i, "");
  if (
    !owner ||
    !repo ||
    owner.includes("/") ||
    repo.includes("/") ||
    owner === "." ||
    owner === ".." ||
    repo === "." ||
    repo === ".."
  ) {
    return null;
  }
  return { owner, repo };
}

/**
 * Validate a clone source. Accepts GitHub URLs, `owner/repo` shorthand (expanded to an https
 * GitHub URL) and other git URLs (https, ssh, file). Never anything that git could read as an
 * option.
 */
export function normalizeCloneUrl(input: string): { url: string; name: string } {
  const value = input.trim();
  if (!value || value.startsWith("-") || /\s/.test(value)) {
    throw badRequest("Enter a git URL or owner/repo", "invalid_clone_url");
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    const [owner, repo] = value.split("/") as [string, string];
    const cleanRepo = repo.replace(/\.git$/, "");
    return { url: `https://github.com/${owner}/${cleanRepo}.git`, name: cleanRepo };
  }
  if (!/^(https?:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/)/i.test(value)) {
    throw badRequest("Unsupported clone URL", "invalid_clone_url");
  }
  const last = value.replace(/\/+$/, "").split(/[/:]/).at(-1) ?? "";
  const name = last.replace(/\.git$/i, "");
  if (!name) throw badRequest("Cannot work out the repository name", "invalid_clone_url");
  return { url: value, name };
}

/** Package manager from lock files, then `package.json#packageManager`. */
export function detectPackageManager(dir: string): PackageManager | null {
  const locks: Array<[string, PackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];
  for (const [file, pm] of locks) if (existsSync(join(dir, file))) return pm;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      packageManager?: unknown;
    };
    if (typeof pkg.packageManager === "string") {
      const name = pkg.packageManager.split("@")[0];
      if (name === "pnpm" || name === "npm" || name === "yarn" || name === "bun") return name;
    }
    return "npm";
  } catch {
    return null;
  }
}

/** Worktree setup commands to suggest for a package manager (§14 step 5). */
export function suggestedSetup(pm: PackageManager | null): string[] {
  return pm ? [`${pm} install`] : [];
}

/** True when `path` exists and is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether two paths name the same folder, following symlinks (macOS `/var` → `/private/var`)
 * and ignoring case on Windows.
 */
export function sameRealPath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  };
  const [x, y] = [real(a), real(b)];
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

async function git(exec: Exec, cwd: string, args: string[]): Promise<string | null> {
  const result = await exec("git", ["-C", cwd, ...args], { timeoutMs: 10_000 });
  return result.code === 0 ? result.stdout.trim() || null : null;
}

/** A folder's git root (null: none) and package manager, before any remote or branch is read. */
function baseDetection(dir: string, root: string | null): ProjectDetection {
  const packageManager = detectPackageManager(dir);
  return {
    isGitRepo: root !== null,
    gitRoot: root ? resolve(root) : null,
    remoteUrl: null,
    github: null,
    forge: null,
    defaultBranch: null,
    currentBranch: null,
    packageManager,
    suggestedSetupCommands: suggestedSetup(packageManager),
  };
}

/**
 * What `detectProject` finds in a folder that git can't find a checkout for, without running
 * git: there is no `.git` (a folder, or a worktree's file) in it or in any folder above it,
 * which is where git looks. Null when there is one: only git can tell what it is. Only a few
 * file checks, so server start runs it for every project before it serves anything (#454).
 */
export function detectPlainFolder(dir: string): ProjectDetection | null {
  for (let at = resolve(dir); ; ) {
    if (existsSync(join(at, ".git"))) return null;
    const parent = dirname(at);
    if (parent === at) return baseDetection(dir, null);
    at = parent;
  }
}

/** Inspect a folder: git checkout, remote, GitHub and configured-forge coordinates, branches, package manager. */
export async function detectProject(
  exec: Exec,
  dir: string,
  forgeConnections: readonly ForgejoSettings[] = [],
): Promise<ProjectDetection> {
  const root = await git(exec, dir, ["rev-parse", "--show-toplevel"]);
  const base = baseDetection(dir, root);
  if (!root) return base;

  const [rawRemote, originHead, current] = await Promise.all([
    git(exec, dir, ["remote", "get-url", "origin"]),
    git(exec, dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
    git(exec, dir, ["symbolic-ref", "--short", "HEAD"]),
  ]);
  // A token embedded in the remote URL must never reach the event log or the UI.
  const remoteUrl = rawRemote ? redactUrls(rawRemote) : null;
  const defaultBranch = originHead?.replace(/^origin\//, "") ?? current;
  const gh = remoteUrl ? parseGitHubRemote(remoteUrl) : null;
  const forgeMatches = remoteUrl ? matchForgejoRemote(remoteUrl, forgeConnections) : [];
  // More than one connection matching means "do not guess": the project stays local.
  const onlyForge = forgeMatches.length === 1 ? forgeMatches[0] : undefined;
  const forge =
    remoteUrl && onlyForge ? forgeRepoOf(remoteUrl, onlyForge, defaultBranch ?? "main") : null;
  return {
    ...base,
    remoteUrl,
    currentBranch: current,
    defaultBranch,
    github: gh && remoteUrl ? { ...gh, remoteUrl, defaultBranch: defaultBranch ?? "main" } : null,
    forge,
  };
}

function forgeRepoOf(
  remoteUrl: string,
  match: ForgejoRemoteMatch,
  defaultBranch: string,
): ForgeRepo {
  return {
    provider: "forgejo",
    baseUrl: match.baseUrl,
    host: match.host,
    owner: match.owner,
    repo: match.repo,
    remoteUrl,
    defaultBranch,
  };
}
