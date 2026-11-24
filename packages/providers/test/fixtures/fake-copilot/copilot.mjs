// A scripted stand-in for Copilot CLI's ACP server (`copilot --acp`), in the shapes 1.0.115
// uses. It runs the generic scripted agent with Copilot's own argument and version, so a test
// can script Copilot's permission requests (see `fake-acp/agent.mjs` for the step format).
if (process.argv[2] === "--acp") process.argv[2] = "acp";
process.env.FAKE_ACP_VERSION ??= "1.0.115";
await import("../fake-acp/agent.mjs");
