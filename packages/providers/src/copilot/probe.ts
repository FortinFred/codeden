import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAgent } from "../acp/process";
import type { AcpInitializeResult, AcpSessionSetup } from "../acp/protocol";
import { AcpRpcError, METHOD_NOT_FOUND } from "../acp/rpc";
import type { ResolvedCommand } from "../util/exec";

/** The arguments that start Copilot CLI's ACP server (stdio, its default transport). */
export const COPILOT_ACP_ARGS = ["--acp"] as const;

/** What a short-lived `copilot --acp` showed. */
export interface CopilotProbe {
  /** The CLI answered `initialize` with ACP version 1. */
  acp: boolean;
  /**
   * `session/new` succeeded: the CLI is signed in, or runs on a model provider of its own. The
   * CLI refuses to open a session without either (`copilot help acp`).
   */
  session: boolean;
  /** What it reported in `initialize` (its capabilities). */
  info?: AcpInitializeResult;
  /** What `session/new` reported (modes, and models in the CLIs that list them). */
  setup?: AcpSessionSetup;
  /** Why the ACP server or the session didn't start, when it didn't. */
  error?: string;
}

/** A folder of CodeDen's own to run the probe in, so it never touches a project. */
function scratchDir(): string {
  const dir = path.join(tmpdir(), "codeden-copilot-probe");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // The probe still runs, in the runner's own folder.
  }
  return dir;
}

/**
 * Start `copilot --acp` once, check it answers `initialize`, and open a session in a scratch
 * folder to confirm it is signed in. No `authenticate` (that would start a sign-in flow), no
 * prompt, and no model call: an empty session leaves no history behind. Never throws.
 */
export async function probeCopilot(
  exe: ResolvedCommand,
  opts: { timeoutMs?: number } = {},
): Promise<CopilotProbe> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let stderr = "";
  const result: CopilotProbe = { acp: false, session: false };
  let started: Awaited<ReturnType<typeof startAgent>> | undefined;
  try {
    started = await startAgent(
      exe,
      {
        onNotification: () => {},
        onRequest: async () => {
          throw new AcpRpcError(METHOD_NOT_FOUND, "not supported");
        },
        onExit: (_code, tail) => {
          stderr = tail;
        },
      },
      {
        args: COPILOT_ACP_ARGS,
        label: "Copilot CLI",
        cwd: scratchDir(),
        timeoutMs,
      },
    );
    result.acp = true;
    result.info = started.info;
  } catch (error) {
    result.error = describe(error, stderr);
    await started?.rpc.close();
    return result;
  }
  try {
    const setup = await withTimeout(
      started.rpc.request<AcpSessionSetup>("session/new", {
        cwd: scratchDir(),
        mcpServers: [],
      }),
      timeoutMs,
    );
    result.session = true;
    result.setup = setup ?? {};
  } catch (error) {
    result.error = describe(error, stderr);
  }
  await started.rpc.close();
  return result;
}

/** The server's message, with the last lines it wrote to stderr, clipped for a setup check. */
function describe(error: unknown, stderr: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return [message, stderr.trim().split(/\r?\n/).slice(-3).join(" ")]
    .filter(Boolean)
    .join(": ")
    .slice(0, 400);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** True when a refused session is about the CLI's sign-in rather than a crash or a setting. */
export function isCopilotSignInError(message: string | undefined): boolean {
  return (
    !!message &&
    /auth|log ?in|sign ?in|credential|\btoken\b|unauthori[sz]ed|\b401\b|subscription|licen[cs]e/i.test(
      message,
    )
  );
}
