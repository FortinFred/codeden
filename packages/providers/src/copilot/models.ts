import type { ModelInfo } from "@codeden/contracts";
import type { AcpModel } from "../acp/config";
import { DEFAULT_MODEL_ID } from "../util/model";

/** The model Copilot CLI's own `auto` setting runs: it picks a model for each task. */
const AUTO_MODEL_ID = "auto";

const CONFIGURED_MODEL = "The model selected in Copilot CLI (its own setting)";

/**
 * Copilot CLI's models as its own help lists them (`copilot help config`, the `model` setting),
 * for the first launch and for CLIs whose help can't be read. The CLI is asked again by
 * `refreshModels`, so a new release's list replaces this one.
 */
export const DOCUMENTED_COPILOT_MODELS: readonly string[] = [
  "claude-sonnet-5.5",
  "claude-sonnet-5",
  "claude-fable-5.2",
  "claude-fable-5.1",
  "claude-fable-5",
  "claude-opus-5.5",
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-opus-4.8-fast",
  "claude-sonnet-4.6",
  "claude-haiku-5.5",
  "claude-haiku-4.5",
  "gpt-6.2-sol",
  "gpt-6.2-astra",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.3-codex",
  "mai-code-1.1-flash",
  "gemini-4-carbon",
  "gemini-4-argon",
  "gemini-3.8-flash",
  "grok-4.7",
  "grok-4.6",
  "kimi-k3",
];

/** Words that keep their own capitalisation in a model's label ("GPT 5.6 Sol"). */
const UPPER = new Set(["gpt", "mai", "ai"]);

/** A model id as a readable label: `claude-sonnet-5.5` -> "Claude Sonnet 5.5". */
export function copilotModelLabel(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((word) => (UPPER.has(word) ? word.toUpperCase() : word[0]?.toUpperCase() + word.slice(1)))
    .join(" ");
}

/** "Default" leaves the choice to Copilot CLI's own setting. */
function defaultModel(): ModelInfo {
  return {
    id: DEFAULT_MODEL_ID,
    label: "Default",
    description: CONFIGURED_MODEL,
    efforts: [],
    isDefault: true,
  };
}

/** Copilot CLI's `auto`: it routes each task to a model it picks. */
function autoModel(): ModelInfo {
  return {
    id: AUTO_MODEL_ID,
    label: "Auto",
    description: "Copilot picks a model for each task",
    efforts: [],
  };
}

/**
 * A model id from the CLI's own list as CodeDen shows it. Copilot CLI takes a reasoning effort
 * at launch only, not per session, so no model offers efforts.
 */
export function copilotModelInfo(id: string): ModelInfo {
  return { id, label: copilotModelLabel(id), efforts: [] };
}

/**
 * The list before anything is known: Default, Auto, then the models the CLI's help documents.
 * `refreshModels` replaces it with the CLI's current list.
 */
export function fallbackCopilotModels(): ModelInfo[] {
  return [defaultModel(), autoModel(), ...DOCUMENTED_COPILOT_MODELS.map(copilotModelInfo)];
}

/**
 * The models the CLI's help documents (`copilot help config`), after Default and Auto. An empty
 * `ids` list gives the fallback unchanged.
 */
export function copilotModelsFromIds(ids: readonly string[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [defaultModel(), autoModel()];
  for (const id of ids) {
    if (!id || id === DEFAULT_MODEL_ID || id === AUTO_MODEL_ID || seen.has(id)) continue;
    seen.add(id);
    out.push(copilotModelInfo(id));
  }
  return out;
}

/**
 * The models a Copilot session reports (a `model` config option, in the CLIs that list one),
 * after Default and Auto.
 */
export function copilotSessionModels(models: readonly AcpModel[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [defaultModel(), autoModel()];
  for (const m of models) {
    if (!m.id || m.id === DEFAULT_MODEL_ID || m.id === AUTO_MODEL_ID || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({
      id: m.id,
      label: m.name || copilotModelLabel(m.id),
      ...(m.description ? { description: m.description } : {}),
      efforts: [],
    });
  }
  return out;
}

/**
 * The model ids in `copilot help config`'s `model` setting: the bulleted `- "id"` lines of that
 * section, up to the next setting. Unknown output gives an empty list.
 */
export function parseCopilotModelChoices(help: string): string[] {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*`model`:/.test(line));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const bullet = /^\s*-\s*"([^"\s]+)"\s*$/.exec(line);
    if (bullet?.[1]) {
      if (!out.includes(bullet[1])) out.push(bullet[1]);
      continue;
    }
    // The list ends at the next setting, or at the blank line before it.
    if (out.length) break;
    if (/^\s*`[^`]+`:/.test(line)) break;
  }
  return out;
}
