# Copilot CLI 1.0.114 approval evidence

Real `copilot --acp` (stdio), scratch folder, every JSON-RPC frame logged. Prompts are small model turns; no login file was read. Logs attached are raw NDJSON (`dir: "out"` is what CodeDen's client sent, `dir: "in"` what Copilot sent; `answer:*` entries are the client's answers to agent requests, recorded by the probe).

## Ask shapes (all on the root session, same three options)

- `run-write.jsonl`: shell `kind:"execute"` (`rawInput.command`, `commands`) and `apply_patch` `kind:"edit"` (`rawInput.fileName`, `diff`, `locations`).
- `run-url.jsonl`: `kind:"fetch"`, `rawInput:{url}`, title `Fetch content from this URL.`
- `run-path.jsonl`: `kind:"read"`, title `Access paths outside trusted directories`, `locations:[{path:"/etc/hostname"}]`.
- `run-mcp.jsonl`: tool call titled `probe-probe_echo`; the ask is `kind:"other"` titled only `probe_echo`, `rawInput` = the tool's arguments.
- `run-subagent.jsonl`: the subagent's shell tool call carries `_meta: {"github.com/copilot":{"agentId":"cc6be2f7-…"}}`; the ask repeats the call **without `_meta`** and on the root session id.

## The silent end (the user's report)

Same prompt (`mkdir -p <dir>`) with the ask answered four ways:

```
allow_once   -> prompt result end_turn, tool_call_update completed, model "codeden-probe"
reject_once  -> prompt result end_turn, tool_call_update failed, agent_message "Info: Operation cancelled by user"
cancelled    -> prompt result end_turn at once, NO tool_call_update, NO agent_message   (run-cancel.jsonl)
JSON-RPC error -> prompt result end_turn at once, NO tool_call_update, NO agent_message (run-error.jsonl)
```

That is copilot-cli#5514's mechanism (a failed/cancelled permission request is a user denial and the turn ends with no model call). CodeDen used to answer `cancelled` whenever no turn was running — where a background subagent's ask lands — and the ask was never shown.

## Through CodeDen's adapter, real CLI, Supervised

Shell turn (allow), then deny:

```
APPROVAL {"title":"Run `mkdir -p e2e-dir; printf 'exit_code=%s\\n' \"$?\"`","action":"command"}
TOOL {"title":"Create e2e-dir and print the command exit code","status":"completed"}
MESSAGE "exit_code=0"
END {"type":"turn.completed","stopReason":"end_turn"}
APPROVAL {"title":"Run `mkdir -p denied-dir; printf 'exit_code=%s\\n' \"$?\"`","action":"command"}
TOOL {"title":"Create denied-dir and print the command exit code","status":"failed"}
MESSAGE "Info: Operation cancelled by user"
END {"type":"turn.completed","stopReason":"end_turn"}
```

A `task` subagent's shell ask (same session):

```
TOOL {"title":"Run mkdir command","toolKind":"other"}
APPROVAL {"title":"Subagent: Run `mkdir -p sub-e2e`","action":"command"}
TOOL {"title":"Create sub-e2e directory","toolKind":"command"}
MESSAGE "The command `mkdir -p sub-e2e` succeeded.The subagent reported that `mkdir -p sub-e2e` succeeded."
END {"type":"turn.completed","stopReason":"end_turn"}
```

## What could not be reproduced live

`task` with `mode:"background"` fails before any permission request on this account with `400 The requested model is not supported` (also with `--model auto`, `claude-sonnet-5.5`, `claude-haiku-4.5`), so the out-of-turn path is covered by #5514's ACP-level report and by the fake-agent regression test. `ask_user` is not offered to the model in ACP mode ("I can't ask through an `ask_user` tool because it isn't available in this session").
