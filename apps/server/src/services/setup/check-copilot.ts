import {
  COPILOT_UPGRADE_COMMAND,
  copilotTooOldMessage,
  isCopilotSignInError,
  isSupportedCopilotVersion,
  probeCopilot,
  resolveExecutable,
} from "@codeden/providers";
import { base, type CheckEnv, type CheckResult, installFix } from "./check-base";
import { loginFix, lookupTool } from "./tool-lookup";

/**
 * Copilot CLI (§14): a working `copilot` (PATH, then its installers' folders) of at least the
 * version CodeDen supports, then one short `copilot --acp` session to see whether it is signed
 * in. The CLI refuses to open a session without a login or a model provider of the user's own,
 * so an opened session answers the login question without reading a credential. Sign in runs
 * `copilot login` in the setup terminal.
 */
export async function checkCopilot({
  locate,
  shell,
  platform,
  copilotProbe,
}: CheckEnv): Promise<CheckResult> {
  const tool = await lookupTool(locate, "copilot", base("copilot"), {
    message: "Copilot CLI is not installed",
    fix: installFix("copilot", platform),
  });
  if (!tool.found) return tool.result;
  const installed = {
    ...base("copilot"),
    ...tool.extra,
    installed: true,
    version: tool.version,
    executablePath: tool.path,
  };
  if (!isSupportedCopilotVersion(tool.version)) {
    // Sessions refuse to open on it: "Copilot CLI 1.0.90 is too old (needs 1.0.105+)".
    return {
      ...installed,
      state: "missing",
      message: copilotTooOldMessage(tool.version),
      fix: { kind: "upgrade", command: COPILOT_UPGRADE_COMMAND },
    };
  }
  const login = loginFix("copilot", shell, tool.path);
  const exe = resolveExecutable(tool.path) ?? { kind: "native" as const, path: tool.path };
  const probe = copilotProbe
    ? await copilotProbe(exe)
    : await probeCopilot(exe, { timeoutMs: 10_000 });
  if (!probe.acp) {
    return {
      ...installed,
      state: "missing",
      message: "This Copilot CLI did not start its ACP server (`copilot --acp`); update it",
      ...(probe.error ? { detail: probe.error } : {}),
      fix: { kind: "upgrade", command: COPILOT_UPGRADE_COMMAND },
    };
  }
  if (probe.session) {
    return {
      ...installed,
      loggedIn: true,
      authMethod: "copilot",
      state: "ok",
      message: "Signed in",
    };
  }
  if (isCopilotSignInError(probe.error)) {
    return {
      ...installed,
      loggedIn: false,
      state: "missing",
      message: "Not signed in to Copilot CLI",
      ...(probe.error ? { detail: probe.error } : {}),
      fix: login,
    };
  }
  return {
    ...installed,
    state: "warning",
    message: "Could not confirm the Copilot CLI sign-in",
    ...(probe.error ? { detail: probe.error } : {}),
    fix: login,
  };
}
