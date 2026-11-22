import type { ForgeRepo, Project, Snapshot } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/http";
import { createMockClient } from "@/lib/api/mock";
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

/** The mock snapshot with this forge project instead of the local fixture. */
async function forgeSnapshot(project: Project): Promise<Snapshot> {
  const client = createMockClient();
  const base = await client.getSnapshot();
  return {
    ...base,
    projects: [...base.projects.filter((p) => p.id !== local.id), project],
  };
}

describe("a forge project", () => {
  it("shows its forge coordinates without the GitHub tab, and never fetches GitHub", async () => {
    const client = createMockClient();
    const snapshot = await forgeSnapshot(forgeProject);
    client.getSnapshot = async () => snapshot;
    const prs = vi.fn();
    const issues = vi.fn();
    client.github.prs = prs;
    client.github.issues = issues;

    // Even a deep link to the GitHub tab falls back to the overview for a forge project.
    renderWithClient(<ProjectPage projectId={forgeProject.id} tab="github" />, client, {
      withRouter: true,
    });

    const header = await screen.findByTestId("project-forge-repo");
    expect(header.textContent).toContain("Forgejo repository");
    expect(header.textContent).toContain("forge.example.com/acme/widgets");
    expect(screen.queryByRole("tab", { name: "GitHub" })).toBeNull();
    expect(screen.queryByTestId("project-github")).toBeNull();
    expect(prs).not.toHaveBeenCalled();
    expect(issues).not.toHaveBeenCalled();
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
