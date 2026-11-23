import type { ItemOf } from "@codeden/contracts";
import type { ApprovalBroker } from "../approvals";
import { shorten, toJson } from "../util/text";
import { type AcpToolState, commandOf, mcpOf, pathsOf, workdirOf } from "./items";
import type { AcpEventMapper } from "./mapper";
import type { AcpPolicy, AcpPolicyDecision } from "./policy";
import { WRITE_KINDS } from "./policy";
import type { AcpPermissionOption, AcpPermissionRequest, AcpPermissionResult } from "./protocol";

/** What answering a permission request needs from the session. */
export interface AcpApprovalDeps {
  broker: ApprovalBroker;
  policy: AcpPolicy;
  mapper: AcpEventMapper;
  cwd: string;
  /** The agent's name, for notices ("Copilot CLI", "Cursor"). */
  label: string;
  mcpServers: readonly string[];
  trustedServers: readonly string[];
  /** The agent's own answer to this request (`AcpExtensions.permission`), if it has one. */
  own?: (call: AcpToolState) => Promise<AcpPermissionResult> | undefined;
}

const CANCELLED: AcpPermissionResult = { outcome: { outcome: "cancelled" } };

/**
 * Answer `session/request_permission` (§11.2): CodeDen's policy approves or refuses the call
 * on the spot (recorded in the transcript as decided by policy), or it becomes an
 * `approval_request` the user answers. It never throws and never fails the request: Copilot CLI
 * records a failed `session/request_permission` as a user denial and ends the (sub)agent's turn
 * without telling anyone (copilot-cli#5514), so a request CodeDen can't decide is refused with
 * its own answer and a visible notice instead. "Once" options win; an "always" option is chosen
 * only when the agent offers no "once" one, since it saves a rule in the agent's own settings
 * (CodeDen remembers `allow_session` itself for that case). A request with nothing CodeDen can
 * select is answered `cancelled`, with a notice: the agent may then end its turn silently.
 */
export async function answerPermission(
  req: AcpPermissionRequest,
  deps: AcpApprovalDeps,
): Promise<AcpPermissionResult> {
  try {
    return await decidePermission(req, deps);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.mapper.notice(
      "warning",
      `CodeDen could not answer ${deps.label}'s permission request (${shorten(reason, 200)}). The call was refused.`,
      "approval_failed",
    );
    return answerOrCancel(req.options, "reject", deps, "refuse");
  }
}

async function decidePermission(
  req: AcpPermissionRequest,
  deps: AcpApprovalDeps,
): Promise<AcpPermissionResult> {
  const call = deps.mapper.tool(req.toolCall ?? { toolCallId: "" });
  const ctx = deps.mapper.ctx();
  if (!ctx) return CANCELLED;
  const own = deps.own?.(call);
  if (own) return own;
  const decision = deps.policy.decide(call);
  const item = approvalItem(call, decision, deps, deps.mapper.toolItemId(call.toolCallId));
  const trusted = decision.kind === "allow" && isTrustedCall(call, deps);
  if (decision.kind === "allow") {
    if (!trusted) {
      deps.broker.record(ctx, {
        ...item,
        status: "completed",
        reason: `Allowed by the ${levelName(deps.policy.level)} permission level`,
        decision: "allow_once",
        decidedBy: "policy",
      });
    }
    return answerOrCancel(req.options, "allow", deps, "allow");
  }
  if (decision.kind === "deny") {
    deps.broker.record(ctx, {
      ...item,
      status: "declined",
      reason: decision.message,
      decision: "deny",
      decidedBy: "policy",
    });
    return answerOrCancel(req.options, "reject", deps, "refuse");
  }
  const response = await deps.broker.request(ctx, item);
  if (response.kind === "approval" && response.decision !== "deny") {
    if (response.decision === "allow_session") deps.policy.allowForSession(call);
    return answerOrCancel(req.options, "allow", deps, "allow");
  }
  if (response.kind === "approval") {
    return answerOrCancel(req.options, "reject", deps, "refuse");
  }
  return CANCELLED;
}

/**
 * Select an answer, or, when the agent offered no option of that kind at all, say in the
 * transcript that the request can only be cancelled: an unanswered call would otherwise end the
 * agent's turn with nothing to show for it (copilot-cli#5514).
 */
function answerOrCancel(
  options: readonly AcpPermissionOption[],
  want: "allow" | "reject",
  deps: Pick<AcpApprovalDeps, "mapper" | "label">,
  verb: "allow" | "refuse",
): AcpPermissionResult {
  const result = select(options, want);
  if (result.outcome.outcome === "selected") return result;
  deps.mapper.notice(
    "warning",
    `${deps.label} asked for permission but offered no option to ${verb} the call, so the request was cancelled and its turn may end.`,
    "approval_unanswerable",
  );
  return CANCELLED;
}

/**
 * The option to answer a request with: the "once" option of a kind, else (when the agent offers
 * no "once" option) its "always" option. An agent with neither leaves nothing to select, so the
 * request is answered `cancelled`; a refusal also never picks an allow option.
 */
export function select(
  options: readonly AcpPermissionOption[],
  want: "allow" | "reject",
): AcpPermissionResult {
  const list = Array.isArray(options) ? options : [];
  const option =
    list.find((o) => o.kind === `${want}_once`) ??
    list.find((o) => o.kind === `${want}_always`) ??
    // Approval but no allow option: refuse rather than let the call run unanswered.
    (want === "allow"
      ? list.find((o) => o.kind === "reject_once" || o.kind === "reject_always")
      : undefined);
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : CANCELLED;
}

/**
 * A call to CodeDen's own MCP tools: allowed silently, never recorded as a decision. Only calls
 * of kind `other` qualify (`mcpOf`), never a command or an edit titled like one.
 */
function isTrustedCall(call: AcpToolState, deps: AcpApprovalDeps): boolean {
  const mcp = mcpOf(call, deps.mcpServers);
  return mcp !== undefined && deps.trustedServers.includes(mcp.server);
}

function levelName(level: string): string {
  return level === "full" ? "Full" : level === "supervised" ? "Supervised" : "Auto";
}

/**
 * The approval card for a permission request. A call a subagent made says so in its title
 * (`call.agent`, the agent's own id for it): Copilot CLI's subagent asks arrive on the root
 * session, and the ask itself doesn't name the subagent.
 */
export function approvalItem(
  call: AcpToolState,
  decision: AcpPolicyDecision,
  deps: Pick<AcpApprovalDeps, "cwd" | "mcpServers">,
  /** The `tool_call` item the request gates. */
  toolItemId?: string,
): ItemOf<"approval_request"> {
  const requestId = `perm-${call.toolCallId || "call"}-${Math.random().toString(36).slice(2, 8)}`;
  const base = {
    id: `approval-${requestId}`,
    kind: "approval_request" as const,
    status: "in_progress" as const,
    requestId,
    action: decision.kind === "ask" ? decision.action : actionOf(call),
    ...(decision.kind === "ask" ? { reason: decision.reason } : {}),
    toolName: call.name || String(call.kind ?? "tool"),
    ...(call.rawInput !== undefined ? { toolInput: toJson(call.rawInput) } : {}),
    ...(call.toolCallId && toolItemId ? { toolCallItemId: toolItemId } : {}),
    options: ["allow_once", "allow_session", "deny"] as ItemOf<"approval_request">["options"],
  };
  const title = call.title?.trim();
  const prefix = call.agent ? "Subagent: " : "";
  switch (call.kind) {
    case "execute": {
      const command = commandOf(call);
      return {
        ...base,
        title: `${prefix}Run \`${shorten(command, 100)}\``,
        command,
        cwd: workdirOf(call, deps.cwd),
      };
    }
    case "edit":
    case "delete":
    case "move": {
      const paths = pathsOf(call, deps.cwd);
      const verb = call.kind === "delete" ? "Delete" : call.kind === "move" ? "Move" : "Edit";
      return {
        ...base,
        title: `${prefix}${
          paths.length === 1 ? `${verb} ${paths[0]}` : title || `${verb} ${paths.length} files`
        }`,
        ...(paths.length ? { paths } : {}),
      };
    }
    default: {
      const mcp = mcpOf(call, deps.mcpServers);
      return {
        ...base,
        title: `${prefix}${mcp ? `Run ${mcp.server}: ${mcp.tool}` : title || `Allow ${base.toolName}`}`,
      };
    }
  }
}

function actionOf(call: AcpToolState): ItemOf<"approval_request">["action"] {
  if (call.kind === "execute") return "command";
  if (WRITE_KINDS.has(String(call.kind))) return "file_change";
  if (call.kind === "fetch") return "network";
  return "tool";
}
