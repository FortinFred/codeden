import type {
  ForgeRepo,
  GithubConnection,
  GithubIssue,
  GithubPr,
  GithubPrDetails,
  GithubSyncStatus,
  Project,
  Session,
  Snapshot,
} from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { GitHubPanel } from "@/components/workbench/github-panel";
import { ApiRequestError } from "@/lib/api/http";
import { createMockClient } from "@/lib/api/mock";
import { mockIssues, mockPrs } from "@/lib/api/mock/fixtures/github";
import { projects as fixtureProjects } from "@/lib/api/mock/fixtures/world";
import { ProjectPage } from "@/routes/project";
import { renderWithClient } from "./utils";

const local = fixtureProjects.find((p) => p.id === "p-notes") as Project;

const forge: ForgeRepo = {
  provider: "forgejo",
  baseUrl: "https://forge.example.com",
  host: "forge.example.com",
  owner: "acme",
  repo: "widgets",
  remoteUrl: "https://forge.example.com/acme/widgets.git",
  defaultBranch: "main",
};

const forgeProject: Project = {
  ...local,
  name: "Widgets",
  slug: "widgets",
  kind: "forge",
  forge,
  autonomyMode: "assisted",
};

const connection: GithubConnection = {
  connected: true,
  source: "keychain",
  login: "lee",
  message: null,
  provider: "forgejo",
  host: "forge.example.com",
};

const sync: GithubSyncStatus = {
  projectId: forgeProject.id,
  lastSyncAt: "2026-11-23T09:58:00.000Z",
  lastError: null,
  intervalMs: 60_000,
  nextSyncAt: null,
};

const issue: GithubIssue = {
  ...(mockIssues[0] as GithubIssue),
  projectId: forgeProject.id,
  number: 7,
  title: "Widgets fall over on start",
  url: "https://forge.example.com/acme/widgets/issues/7",
  labels: ["bug"],
  comments: 1,
  sessionIds: [],
};

const prNumber = 58;
const prId = `${forgeProject.id}:${prNumber}`;
const details: GithubPrDetails = {
  ...(mockPrs[0] as GithubPrDetails),
  id: prId,
  projectId: forgeProject.id,
  number: prNumber,
  title: "Add a widget dashboard",
  url: `https://forge.example.com/acme/widgets/pulls/${prNumber}`,
  author: "lee",
  sessionId: null,
};
const pr: GithubPr = details;

/** The mock snapshot with this forge project instead of the local fixture. */
async function forgeSnapshot(project: Project): Promise<Snapshot> {
  const client = createMockClient();
  const base = await client.getSnapshot();
  return {
    ...base,
    projects: [...base.projects.filter((p) => p.id !== local.id), project],
  };
}

/** A mock client whose issue and PR reads answer from the forge, as the server does in A2. */
async function forgeClient() {
  const client = createMockClient();
  const snapshot = await forgeSnapshot(forgeProject);
  client.getSnapshot = async () => snapshot;
  const issues = vi.fn(async () => ({ connection, sync, issues: [issue] }));
  const prs = vi.fn(async () => ({ connection, sync, prs: [pr] }));
  const pull = vi.fn(async () => details);
  const prDiff = vi.fn(async () => ({
    headSha: details.headSha,
    changedFiles: details.changedFiles,
    files: [],
  }));
  const syncNow = vi.fn(async () => sync);
  client.github.issues = issues;
  client.github.prs = prs;
  client.github.pr = pull;
  client.github.prDiff = prDiff;
  client.github.sync = syncNow;
  return { client, snapshot, issues, prs, pull, prDiff, syncNow };
}

/** Buttons a forge project must not offer until phase B (`docs/forges.md` §4.5). */
const WRITE_BUTTONS = [
  "Squash and merge",
  "Merge",
  "Create issue",
  "Comment",
  "Triage",
  "Attach evidence",
  "Approve",
  "Request changes",
  "Open pull request",
];

describe("a forge project", () => {
  it("shows its synced issues and pull requests from Forgejo, read-only", async () => {
    const { client, issues, prs, pull, syncNow } = await forgeClient();

    renderWithClient(<ProjectPage projectId={forgeProject.id} tab="github" />, client, {
      withRouter: true,
    });

    const tab = await screen.findByRole("tab", { name: "Forgejo" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: "GitHub" })).toBeNull();
    expect(await screen.findByText(issue.title)).toBeTruthy();
    expect(await screen.findByText(details.title)).toBeTruthy();
    expect(screen.getByTestId("forge-read-only").textContent).toContain("Forgejo · read-only");
    expect(issues).toHaveBeenCalledWith(forgeProject.id, "open");
    expect(prs).toHaveBeenCalledWith(forgeProject.id, "open");

    for (const name of WRITE_BUTTONS) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }

    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(syncNow).toHaveBeenCalledWith(forgeProject.id));

    // PR details: checks, reviews and files as on GitHub, still without a merge.
    fireEvent.click(screen.getByTestId("github-pr-row"));
    await screen.findByTestId("pr-details");
    expect(pull).toHaveBeenCalledWith(prId);
    expect(screen.getAllByText(details.title).length).toBeGreaterThan(0);
    expect(screen.getAllByText("ci / typecheck").length).toBeGreaterThan(0);
    expect(screen.getByText("fix(a11y): contrast, focus rings and alt text")).toBeTruthy();
    for (const name of WRITE_BUTTONS) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("shows a session's forge PR without its merge action", async () => {
    const { client, snapshot } = await forgeClient();
    const baseSession = snapshot.sessions.find((s) => s.id === "s-search");
    if (!baseSession) throw new Error("the mock world has no s-search session");
    const forgeSession: Session = {
      ...baseSession,
      id: "s-forge",
      projectId: forgeProject.id,
      issue: { number: issue.number, title: issue.title, url: issue.url },
      pr: { number: prNumber, title: details.title, url: details.url, state: "open" as const },
    };
    client.getSnapshot = async () => ({
      ...snapshot,
      sessions: [...snapshot.sessions, forgeSession],
    });
    client.github.session = vi.fn(async () => ({
      connection,
      issue: { number: issue.number, title: issue.title, url: issue.url },
      pr,
    }));
    client.github.issue = vi.fn(async () => ({ ...issue, recentComments: [] }));

    renderWithClient(<GitHubPanel sessionId={forgeSession.id} />, client);

    await screen.findByTestId("pr-details");
    expect(screen.getByText(issue.title)).toBeTruthy();
    for (const name of WRITE_BUTTONS) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("warns about a missing remote and disconnects the forge", async () => {
    const client = createMockClient();
    const warned: Project = {
      ...forgeProject,
      remoteWarning: {
        code: "forge_remote_missing",
        remoteUrl: "https://gitlab.com/acme/widgets.git",
        detectedAt: local.createdAt,
      },
    };
    const snapshot = await forgeSnapshot(warned);
    client.getSnapshot = async () => snapshot;
    const disconnect = vi.fn(async () => ({ project: { ...forgeProject } }));
    client.disconnectForge = disconnect;

    renderWithClient(<ProjectPage projectId={warned.id} tab="overview" />, client, {
      withRouter: true,
    });

    const banner = await screen.findByTestId("remote-warning");
    expect(banner.textContent).toContain("The Forgejo remote is missing");
    expect(banner.textContent).toContain("acme/widgets");
    expect(banner.textContent).toContain("forge.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect forge" }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith(warned.id));
  });

  it("shows the forge_remote_present refusal like the GitHub one", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => "t");
    const client = createMockClient();
    const warned: Project = {
      ...forgeProject,
      remoteWarning: {
        code: "forge_remote_missing",
        remoteUrl: "https://gitlab.com/acme/widgets.git",
        detectedAt: local.createdAt,
      },
    };
    const snapshot = await forgeSnapshot(warned);
    client.getSnapshot = async () => snapshot;
    const message =
      "origin still matches acme/widgets on forge.example.com; change or remove it first";
    client.disconnectForge = async () => {
      throw new ApiRequestError(409, "forge_remote_present", message);
    };

    renderWithClient(<ProjectPage projectId={warned.id} tab="overview" />, client, {
      withRouter: true,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect forge" }));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Couldn't disconnect the forge", {
        description: message,
      }),
    );
    error.mockRestore();
  });
});
