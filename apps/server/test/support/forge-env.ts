import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Project,
  RawEventEnvelope,
  RunnerCommandName,
  RunnerCommandOf,
  Session,
  Settings,
} from "@codeden/contracts";
import { FactoryLimits, Settings as SettingsSchema } from "@codeden/contracts";
import { type Database, openDatabase } from "../../src/db/client";
import { EventStore } from "../../src/events/store";
import { ArtifactService } from "../../src/services/artifacts";
import type { Exec } from "../../src/services/exec";
import { ForgejoConnection } from "../../src/services/forge/connection";
import { ForgejoClient } from "../../src/services/forge/forgejo/client";
import { ForgeService } from "../../src/services/forge/service";
import { GithubService } from "../../src/services/github/github-service";
import { GithubStore } from "../../src/services/github/store";
import { InboxService } from "../../src/services/inbox-service";
import { ProjectService } from "../../src/services/projects/project-service";
import type { RunnerPort } from "../../src/services/runner-port";
import { MemorySecretStore } from "../../src/services/secrets";
import { SessionRepo } from "../../src/services/sessions/repo";
import { sampleSession } from "../helpers";
import { FakeForgejo } from "./fake-forgejo";
import { removeTree } from "./remove-tree";

/** A fixed "now" for the sync, so the baseline window and backoff are deterministic. */
export const FORGE_TEST_NOW = Date.parse("2026-11-22T10:00:00.000Z");

/**
 * A `ForgeService` and the app's `GithubService` over a real SQLite database and an in-memory
 * Forgejo: issue/PR projections, sync events and the read APIs, with no network and no runner.
 */
export interface ForgeEnv {
  dir: string;
  forge: FakeForgejo;
  db: Database;
  store: EventStore;
  events: RawEventEnvelope[];
  projects: ProjectService;
  service: ForgeService;
  github: GithubService;
  repo: SessionRepo;
  secrets: MemorySecretStore;
  settings: () => Settings;
  /** Everything the forge services logged (an unknown label, a sync failure). */
  logs: string[];
  /** The inbox, for tests that drive triage decisions. */
  inbox: InboxService;
  /** Requests a GitHub call made; a forge project must leave this empty. */
  githubRequests: string[];
  forgeProject: Project;
  githubProject: Project;
  localProject: Project;
  addSession: (patch?: Partial<Session>) => Session;
  close: () => Promise<void>;
}

const ts = "2026-11-07T10:00:00.000Z";

export function createForgeEnv(): ForgeEnv {
  const dir = mkdtempSync(join(tmpdir(), "codeden-forge-"));
  const db = openDatabase(join(dir, "codeden.db"));
  const store = new EventStore(db.db);
  const events: RawEventEnvelope[] = [];
  store.subscribe((batch) => events.push(...batch));
  const forge = new FakeForgejo();
  const secrets = new MemorySecretStore();
  void secrets.set("forgejo.token", forge.token);
  const exec: Exec = async () => ({
    code: null,
    stdout: "",
    stderr: "",
    notFound: true,
    timedOut: false,
    path: null,
  });
  const projects = new ProjectService({ db: db.db, store, exec, projectsDir: dir });
  const withForgeConnection = (): Settings =>
    SettingsSchema.parse({
      forges: { forgejo: { baseUrl: forge.baseUrl, allowInsecureHttp: false } },
    });
  let settings = withForgeConnection();
  const connection = new ForgejoConnection({
    settings: () => settings,
    saveSettings: (forges) => {
      settings = SettingsSchema.parse({ ...settings, forges });
    },
    secrets,
    client: (config, token) =>
      new ForgejoClient({
        baseUrl: config.baseUrl,
        token,
        owner: "_",
        repo: "_",
        allowInsecureHttp: config.allowInsecureHttp,
        fetch: forge.fetch,
      }),
  });
  const data = new GithubStore(db.db);
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);
  const service = new ForgeService({
    store,
    data,
    projects,
    settings: () => settings,
    secrets,
    connection,
    fetch: forge.fetch,
    now: () => FORGE_TEST_NOW,
    log,
  });
  const repo = new SessionRepo(db.db, store);
  mkdirSync(join(dir, "artifacts"));
  const artifacts = new ArtifactService(db.db, store, join(dir, "artifacts"));
  const inbox = new InboxService(db.db, store, () => async () => {});
  const runner = {
    isConnected: () => true,
    runnerId: () => "r1",
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: async (command: RunnerCommandOf<RunnerCommandName>) => {
      void command;
      return {};
    },
  } as unknown as RunnerPort;
  const githubRequests: string[] = [];
  const forbiddenFetch: typeof fetch = async (input) => {
    githubRequests.push(String(input));
    throw new Error("GitHub must not be called for a forge project");
  };
  const github = new GithubService({
    db: db.db,
    store,
    projects,
    repo,
    runner,
    artifacts,
    inbox,
    exec,
    secrets,
    home: dir,
    fetch: forbiddenFetch,
    baseUrl: "https://api.github.test",
    forge: service,
  });
  const base = {
    isGitRepo: true,
    defaultBranch: "main",
    defaultProvider: null,
    autonomy: null,
    autonomyMode: "assisted" as const,
    visionPath: ".codeden/VISION.md",
    factoryLimits: FactoryLimits.parse({}),
    killSwitch: false,
    timezone: null,
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
  };
  const forgeProject = {
    ...base,
    id: "p-forge",
    name: "widgets",
    slug: "widgets",
    path: join(dir, "widgets"),
    kind: "forge",
    forge: {
      provider: "forgejo",
      baseUrl: forge.baseUrl,
      host: "127.0.0.1:3000",
      owner: forge.owner,
      repo: forge.repo,
      remoteUrl: `${forge.baseUrl}/${forge.owner}/${forge.repo}.git`,
      defaultBranch: "main",
    },
  } as Project;
  const githubProject = {
    ...base,
    id: "p-gh",
    name: "github-widgets",
    slug: "github-widgets",
    path: join(dir, "github-widgets"),
    kind: "github",
    github: {
      owner: forge.owner,
      repo: forge.repo,
      remoteUrl: `https://github.com/${forge.owner}/${forge.repo}.git`,
      defaultBranch: "main",
    },
  } as Project;
  const localProject = {
    ...base,
    id: "p-local",
    name: "notes",
    slug: "notes",
    path: join(dir, "notes"),
    kind: "local",
  } as Project;
  store.append([
    { type: "project.created", sessionId: null, payload: { project: forgeProject } },
    { type: "project.created", sessionId: null, payload: { project: githubProject } },
    { type: "project.created", sessionId: null, payload: { project: localProject } },
  ]);
  let n = 0;
  const env: ForgeEnv = {
    dir,
    forge,
    db,
    store,
    events,
    projects,
    service,
    github,
    repo,
    secrets,
    settings: () => settings,
    logs,
    inbox,
    githubRequests,
    forgeProject,
    githubProject,
    localProject,
    addSession: (patch: Partial<Session> = {}) => {
      const session: Session = {
        ...sampleSession,
        id: `s${++n}`,
        projectId: forgeProject.id,
        status: "idle",
        cwd: dir,
        worktreePath: dir,
        branch: `codeden/task-${n}`,
        baseBranch: "main",
        ...patch,
      };
      repo.create(session, {
        workspaceMode: "worktree",
        workspaceFallback: null,
        forced: null,
        queuedBehind: [],
      });
      return session;
    },
    close: async () => {
      service.stop();
      github.stop();
      db.close();
      await removeTree(dir);
    },
  };
  return env;
}
