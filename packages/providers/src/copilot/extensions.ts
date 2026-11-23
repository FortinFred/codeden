import type { AcpExtensions } from "../acp/extensions";
import type { AcpToolFacts } from "../acp/items";
import type { AcpToolCall } from "../acp/protocol";
import { str } from "../util/text";

/**
 * What Copilot CLI's vendor fields say about a tool call: a subagent's calls carry
 * `_meta["github.com/copilot"].agentId`, on the `tool_call`/`tool_call_update` updates. Its
 * permission request repeats the call without `_meta`, so the id is read off the tool call
 * CodeDen already knows and kept on the merged state (`mapper.tool`).
 */
export function copilotFacts(call: AcpToolCall): AcpToolFacts | undefined {
  const meta = (call._meta as Record<string, unknown> | null | undefined)?.["github.com/copilot"];
  const agentId = str(meta, "agentId")?.trim();
  return agentId ? { agent: agentId } : undefined;
}

/**
 * Copilot CLI's ACP server extensions. Subagents are not child sessions (its `initialize`
 * advertises none, and it never sends `subagent_spawned`): they run inside the one ACP session,
 * so their tool calls and permission requests arrive on the root session, and only the agent id
 * on the tool call tells them apart. `ask_user` is not carried over ACP at all (the model is not
 * offered the tool), so `userQuestions` stays false; there are no vendor requests to answer.
 */
export const copilotExtensions: AcpExtensions = {
  toolCall: copilotFacts,
};
