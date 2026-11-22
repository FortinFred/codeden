import type { ProviderIssue, ProviderStatus } from "@codeden/contracts";
import { brokenInstallMessage, type DetectExeOptions, lookupForDetect } from "../util/detect-exe";
import type { ResolvedCommand } from "../util/exec";
import { compareVersions } from "../util/version";
import { type CopilotProbe, isCopilotSignInError } from "./probe";

/**
 * Oldest Copilot CLI CodeDen runs. 1.0.105 is the first stable release that sends
 * `session/request_permission` again in ACP mode: older builds ran tools without asking, which
 * would bypass CodeDen's approvals entirely (§11.2).
 */
export const COPILOT_MIN_VERSION = "1.0.105";

export const COPILOT_INSTALL_COMMAND = "npm install -g @github/copilot";
export const COPILOT_UPGRADE_COMMAND = "copilot update";
export const COPILOT_LOGIN_COMMAND = "copilot login";

/** Whether a Copilot CLI version is one CodeDen supports (prerelease builds count by number). */
export function isSupportedCopilotVersion(version: string | null | undefined): boolean {
  return !!version && compareVersions(version, COPILOT_MIN_VERSION) >= 0;
}

/** "Copilot CLI 1.0.90 is too old (needs 1.0.105+)": detection, setup and a refused open. */
export function copilotTooOldMessage(version: string | null | undefined): string {
  return `Copilot CLI ${version || "(unknown version)"} is too old (needs ${COPILOT_MIN_VERSION}+)`;
}

export interface CopilotDetectOptions extends DetectExeOptions {
  /** Start `copilot --acp` once to check it answers and can open a session (`probeCopilot`). */
  probe?: (exe: ResolvedCommand, version: string | null) => Promise<CopilotProbe>;
}

/**
 * Find a working `copilot` (PATH, then its installers' folders), check its version and that its
 * ACP server starts, and open a session once to see whether it is signed in (§14). The user's
 * own login is reused; credentials are never read or copied. Never throws.
 */
export async function detectCopilot(opts: CopilotDetectOptions = {}): Promise<ProviderStatus> {
  const status: ProviderStatus = {
    providerId: "copilot",
    installed: false,
    version: null,
    executablePath: null,
    loggedIn: null,
    authMethod: null,
    account: null,
    loginExpiresAt: null,
    supported: false,
    issues: [],
    checkedAt: new Date().toISOString(),
  };
  const issues: ProviderIssue[] = [];
  const install = { kind: "install" as const, command: COPILOT_INSTALL_COMMAND };
  const upgrade = { kind: "upgrade" as const, command: COPILOT_UPGRADE_COMMAND };
  const login = { kind: "login" as const, command: COPILOT_LOGIN_COMMAND };
  const lookup = await lookupForDetect("copilot", { ...opts, timeoutMs: opts.timeoutMs ?? 15_000 });
  const broken = lookup.broken.length > 0 ? { broken: lookup.broken } : {};
  const exe = lookup.command;
  if (!exe) {
    issues.push(
      lookup.broken.length > 0
        ? {
            code: "broken_install",
            message: brokenInstallMessage("Copilot CLI", lookup.broken),
            fix: install,
          }
        : {
            code: "not_installed",
            message: "Copilot CLI is not installed (no `copilot` on PATH).",
            fix: install,
          },
    );
    return { ...status, ...broken, issues };
  }
  const found = {
    ...status,
    ...broken,
    installed: true,
    version: lookup.version,
    executablePath: exe.kind === "node-script" ? exe.script : exe.path,
  };
  if (!isSupportedCopilotVersion(lookup.version)) {
    // Sessions refuse to open on it (`CopilotAdapter.openSession`): `minVersion` makes it unavailable.
    issues.push({
      code: "version_unsupported",
      message: `${copilotTooOldMessage(lookup.version)}. Update it.`,
      fix: upgrade,
      minVersion: COPILOT_MIN_VERSION,
    });
    return { ...found, issues };
  }
  let supported = true;
  const probe = await opts.probe?.(exe, lookup.version);
  if (probe && !probe.acp) {
    supported = false;
    issues.push({
      code: "version_unsupported",
      message: `Copilot CLI ${lookup.version} did not start its ACP server (\`copilot --acp\`)${probe.error ? `: ${probe.error}` : ""}. Update it.`,
      fix: upgrade,
    });
    return { ...found, supported, issues };
  }
  if (probe && !probe.session) {
    if (isCopilotSignInError(probe.error)) {
      return {
        ...found,
        supported,
        loggedIn: false,
        issues: [
          {
            code: "not_logged_in",
            message:
              "Copilot CLI is not signed in. Run `copilot login`, or set COPILOT_GITHUB_TOKEN.",
            fix: login,
          },
        ],
      };
    }
    issues.push({
      code: "detect_failed",
      message: `Could not open a Copilot CLI session${probe.error ? `: ${probe.error}` : ""}.`,
      fix: login,
    });
  }
  return {
    ...found,
    supported,
    // `session/new` only succeeds with a sign-in or a model provider of the user's own.
    ...(probe?.session ? { loggedIn: true, authMethod: "copilot" } : {}),
    issues,
  };
}
