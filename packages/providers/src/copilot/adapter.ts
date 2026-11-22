import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderStatus,
  SessionOptions,
} from "@codeden/contracts";
import { modeIds, modelsOf } from "../acp/config";
import type { AcpAgentSpec } from "../acp/extensions";
import type { AcpInitializeResult, AcpSessionSetup } from "../acp/protocol";
import { AcpSession } from "../acp/session";
import { type ProviderAdapter, type ProviderSession, ProviderSessionError } from "../adapter";
import { executableFingerprint, ModelFreshness } from "../freshness";
import { ModelCatalog } from "../models";
import type { ResolvedCommand } from "../util/exec";
import { runCommand } from "../util/exec";
import { findExecutable, type LocateOptions, runsVersion } from "../util/locate";
import {
  COPILOT_UPGRADE_COMMAND,
  copilotTooOldMessage,
  detectCopilot,
  isSupportedCopilotVersion,
} from "./detect";
import {
  copilotModelsFromIds,
  copilotSessionModels,
  fallbackCopilotModels,
  parseCopilotModelChoices,
} from "./models";
import { COPILOT_ACP_ARGS, type CopilotProbe, probeCopilot } from "./probe";

export const COPILOT_PROVIDER_ID = "copilot";

/**
 * Copilot CLI's session modes are named by the ACP specification's URLs, not short ids
 * (`copilot --acp` lists them in `session/new`).
 */
const MODE_BASE = "https://agentclientprotocol.com/protocol/session-modes#";

/** How CodeDen drives `copilot --acp`: its modes. It never runs `authenticate` (that signs in). */
export const COPILOT_AGENT: AcpAgentSpec = {
  label: "Copilot CLI",
  args: COPILOT_ACP_ARGS,
  modes: { agent: `${MODE_BASE}agent`, plan: `${MODE_BASE}plan` },
  // Its ACP server starts HTTP and SSE servers only: stdio ones it takes and ignores.
  mcpTransports: { stdio: false },
};

/**
 * Honest flags (Principle 5). Approvals and the read-only level go through Copilot CLI's
 * permission requests, decided by CodeDen's policy for every call (so autonomy changes apply
 * live). Plan mode is its `plan` mode; resume is `session/load`. Not wired up: questions (its
 * `ask_user` is an interactive form the ACP server doesn't carry), steering (ACP has no way to
 * add input to a running prompt), subagents, rollback, fork and reasoning effort (the CLI takes
 * it at launch, not per session). Images and MCP servers (CodeDen's tools are an HTTP MCP
 * server) follow what the CLI reports in `initialize`; plan mode, what its sessions list.
 */
const BASE_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  steer: false,
  interrupt: true,
  approvals: true,
  userQuestions: false,
  subagents: false,
  rollback: false,
  fork: false,
  images: true,
  planMode: true,
  reasoningEffort: false,
  mcp: true,
  skills: false,
  liveAutonomy: true,
  readOnly: true,
};

export interface CopilotAdapterOptions {
  executable?: ResolvedCommand;
  /** Where to look for the CLI (tests); default PATH, then its installers' folders. */
  locate?: LocateOptions;
  /** Max time for a probe (detection) or for the CLI's own help (its model list). */
  probeTimeoutMs?: number;
  startTimeoutMs?: number;
  interruptTimeoutMs?: number;
}

/** Copilot CLI through its ACP server (`copilot --acp`), one process per session (§7.2). */
export class CopilotAdapter implements ProviderAdapter {
  readonly id = COPILOT_PROVIDER_ID;
  readonly displayName = "Copilot CLI";
  private readonly catalog = new ModelCatalog(fallbackCopilotModels());
  private readonly freshness = new ModelFreshness();
  private info: AcpInitializeResult | undefined;
  /** Whether the last session listed a `plan` mode; unknown until one has. */
  private planListed: boolean | undefined;
  private found: { command: ResolvedCommand; version: string | null } | undefined;
  /** The version the last detection read, for a copy given explicitly instead of looked up. */
  private detectedVersion: string | null | undefined;
  private probing: Promise<CopilotProbe> | undefined;
  private listing: Promise<void> | undefined;
  /** A session listed the account's models: they win over the ones the CLI's help documents. */
  private listed = false;

  constructor(private readonly options: CopilotAdapterOptions = {}) {}

  /**
   * The CLI to run: a given copy (its version is read on the fly), the one detection found,
   * else one looked up now.
   */
  private async executable(): Promise<
    { command: ResolvedCommand; version: string | null } | undefined
  > {
    if (this.options.executable) {
      if (this.detectedVersion === undefined) {
        const run = await runsVersion(this.options.executable, this.options.probeTimeoutMs);
        this.detectedVersion = run.ok ? run.version : null;
      }
      return { command: this.options.executable, version: this.detectedVersion };
    }
    if (this.found) return this.found;
    const lookup = await findExecutable("copilot", {
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
      ...this.options.locate,
    });
    if (!lookup.command) return undefined;
    this.found = { command: lookup.command, version: lookup.version };
    return this.found;
  }

  async detect(): Promise<ProviderStatus> {
    // A reinstall or an uninstall since the last detection: look again.
    this.found = undefined;
    return detectCopilot({
      ...(this.options.executable ? { executable: this.options.executable } : {}),
      ...(this.options.locate ? { locate: this.options.locate } : {}),
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
      probe: (exe, version) => {
        this.found = { command: exe, version };
        this.detectedVersion = version;
        return this.probe(exe);
      },
    });
  }

  /** What the CLI reported in `initialize` refines resume, images and MCP; sessions, plan mode. */
  capabilities(): ProviderCapabilities {
    const caps = this.info?.agentCapabilities;
    return {
      ...BASE_CAPABILITIES,
      ...(caps
        ? {
            resume: caps.loadSession === true,
            images: caps.promptCapabilities?.image === true,
            mcp: caps.mcpCapabilities?.http === true,
          }
        : {}),
      ...(this.planListed === false ? { planMode: false } : {}),
    };
  }

  models(): ModelInfo[] {
    return this.catalog.list();
  }

  onModelsChanged(listener: () => void): () => void {
    return this.catalog.subscribe(listener);
  }

  /**
   * Ask the CLI for the models its own help documents (`copilot help config`), without a
   * session or a model call. CLIs that print no list keep the fallback. Never throws.
   */
  async refreshModels(opts: { maxAgeMs?: number } = {}): Promise<void> {
    const exe = (await this.executable())?.command;
    if (!exe) return;
    if (
      opts.maxAgeMs !== undefined &&
      !this.listing &&
      this.freshness.isFresh(executableFingerprint(exe), opts.maxAgeMs)
    ) {
      return;
    }
    this.listing ??= this.listModels(exe)
      .catch(() => undefined)
      .finally(() => {
        this.listing = undefined;
      });
    await this.listing;
  }

  private async listModels(exe: ResolvedCommand): Promise<void> {
    // A session's list is the account's own: the documented ids don't replace it.
    if (this.listed) return;
    const run = await runCommand(exe, ["help", "config"], {
      timeoutMs: this.options.probeTimeoutMs ?? 15_000,
    });
    if (run.code !== 0) return;
    const ids = parseCopilotModelChoices(run.stdout);
    if (!ids.length) return;
    this.freshness.confirm(executableFingerprint(exe));
    this.catalog.set(copilotModelsFromIds(ids));
  }

  async openSession(opts: SessionOptions): Promise<ProviderSession> {
    const found = await this.executable();
    if (!found) {
      throw new Error("Copilot CLI is not installed (no `copilot` on PATH)");
    }
    if (found.version && !isSupportedCopilotVersion(found.version)) {
      throw new ProviderSessionError(
        "version_unsupported",
        `${copilotTooOldMessage(found.version)}. Update it with \`${COPILOT_UPGRADE_COMMAND}\`.`,
        "setup",
      );
    }
    const session = new AcpSession(opts, {
      executable: found.command,
      spec: COPILOT_AGENT,
      onSetup: (setup, info) => this.onSetup(setup, info),
      ...(this.options.startTimeoutMs ? { startTimeoutMs: this.options.startTimeoutMs } : {}),
      ...(this.options.interruptTimeoutMs
        ? { interruptTimeoutMs: this.options.interruptTimeoutMs }
        : {}),
    });
    try {
      await session.start();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  /** A session reported its models and modes: they are the account's current ones. */
  private onSetup(setup: AcpSessionSetup, info: AcpInitializeResult): void {
    this.info = info;
    this.applySetup(setup);
  }

  /** The modes and models a session reported (a `plan` mode, a `model` config option). */
  private applySetup(setup: AcpSessionSetup): void {
    const modes = modeIds(setup);
    if (modes.length) this.planListed = modes.includes(COPILOT_AGENT.modes.plan ?? "plan");
    const reported = modelsOf(setup);
    if (!reported?.models.length) return;
    this.listed = true;
    this.freshness.confirm(executableFingerprint(this.found?.command));
    this.catalog.set(copilotSessionModels(reported.models));
  }

  /**
   * One probe at a time; its report refines capabilities and, when it lists models (the CLIs
   * that expose a `model` config option), the model list.
   */
  private probe(exe: ResolvedCommand): Promise<CopilotProbe> {
    this.probing ??= probeCopilot(exe, {
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
    })
      .then((result) => {
        if (result.info) this.info = result.info;
        if (result.setup) this.applySetup(result.setup);
        return result;
      })
      .finally(() => {
        this.probing = undefined;
      });
    return this.probing;
  }
}
