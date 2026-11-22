import type { ForgeConnectionStatus } from "@codeden/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ForgesSettings } from "@/components/settings/sections-forges";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

const connected: ForgeConnectionStatus = {
  provider: "forgejo",
  connected: true,
  baseUrl: "https://forge.example.com",
  host: "forge.example.com",
  login: "lee",
  message: "Connected as lee",
  version: "17.0.2",
};

const statuses: [string, ForgeConnectionStatus, string, string][] = [
  [
    "not configured",
    {
      provider: "forgejo",
      connected: false,
      baseUrl: null,
      host: null,
      login: null,
      message: "Forgejo is not configured. Add its URL and an access token in Settings.",
      version: null,
    },
    "not_configured",
    "not configured",
  ],
  [
    "configured without a token",
    {
      provider: "forgejo",
      connected: false,
      baseUrl: "https://forge.example.com",
      host: "forge.example.com",
      login: null,
      message: "Forgejo is configured, but no access token is stored. Add one in Settings.",
      version: null,
    },
    "no_token",
    "no access token",
  ],
  ["connected as a login", connected, "connected", "Connected as lee on Forgejo 17.0.2"],
  [
    "connected with an unknown viewer",
    {
      ...connected,
      login: null,
      message:
        "Connected to Forgejo; the token cannot read its account (it may be a repository-only token).",
    },
    "unknown_viewer",
    "repository-only token",
  ],
  [
    "a rejected token",
    {
      ...connected,
      connected: false,
      login: null,
      version: null,
      message: "Forgejo rejected the token.",
    },
    "error",
    "Forgejo rejected the token.",
  ],
  [
    "an unreachable instance",
    {
      ...connected,
      connected: false,
      login: null,
      version: null,
      message: "fetch failed",
    },
    "error",
    "fetch failed",
  ],
];

/** The card against a scripted connection status. */
function renderCard(status: ForgeConnectionStatus) {
  const client = createMockClient();
  client.forges.list = vi.fn(async () => ({ forges: [status] }));
  return renderWithClient(<ForgesSettings />, client);
}

describe("Settings → Forges → Forgejo", () => {
  it.each(statuses)("shows %s", async (_name, status, state, text) => {
    renderCard(status);
    const badge = await screen.findByTestId("forgejo-status");
    await waitFor(() => expect(badge.getAttribute("data-state")).toBe(state));
    expect(badge.textContent).toContain(text);
  });

  it("tests the values in the form and reports the result", async () => {
    const { client } = renderCard({
      ...connected,
      connected: false,
      baseUrl: null,
      host: null,
      login: null,
      version: null,
      message: "Forgejo is not configured. Add its URL and an access token in Settings.",
    });
    const test = vi.fn(async () => connected);
    client.forges.testForgejo = test;

    fireEvent.change(screen.getByLabelText("Forgejo URL"), {
      target: { value: "https://forge.example.com" },
    });
    fireEvent.change(screen.getByLabelText("Forgejo access token"), {
      target: { value: "a-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Test connection/ }));

    expect(await screen.findByText("Connected as lee on Forgejo 17.0.2")).toBeTruthy();
    expect(test).toHaveBeenCalledWith({
      baseUrl: "https://forge.example.com",
      allowInsecureHttp: false,
      token: "a-token",
    });
  });

  it("saves the connection with a write-only token", async () => {
    const { client } = renderCard({
      ...connected,
      connected: false,
      baseUrl: null,
      host: null,
      login: null,
      version: null,
      message: "Forgejo is not configured. Add its URL and an access token in Settings.",
    });
    const save = vi.fn(async () => connected);
    client.forges.saveForgejo = save;

    fireEvent.change(screen.getByLabelText("Forgejo URL"), {
      target: { value: "https://forge.example.com" },
    });
    fireEvent.change(screen.getByLabelText("Forgejo access token"), {
      target: { value: "a-token" },
    });
    fireEvent.click(screen.getByTestId("forgejo-save"));

    expect(await screen.findByText("Connected as lee on Forgejo 17.0.2")).toBeTruthy();
    expect(save).toHaveBeenCalledWith({
      baseUrl: "https://forge.example.com",
      allowInsecureHttp: false,
      token: "a-token",
    });
    // The token is write-only: the field empties after saving.
    await waitFor(() =>
      expect(screen.getByLabelText("Forgejo access token")).toHaveProperty("value", ""),
    );
  });

  it("disconnects the connection and its token after a confirmation", async () => {
    const { client } = renderCard(connected);
    const remove = vi.fn(
      async (): Promise<ForgeConnectionStatus> => ({
        provider: "forgejo",
        connected: false,
        baseUrl: null,
        host: null,
        login: null,
        message: "Forgejo is not configured. Add its URL and an access token in Settings.",
        version: null,
      }),
    );
    client.forges.removeForgejo = remove;

    await screen.findByText("Connected as lee on Forgejo 17.0.2");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("removes the connection and its token");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("forgejo-status").getAttribute("data-state")).toBe(
        "not_configured",
      ),
    );
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });
});
