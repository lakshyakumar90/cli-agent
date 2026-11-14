/**
 * Phase 8 demo: what the project adds to the agent.
 *
 * Builds a session in a directory that has an MCP server, a hook and an
 * extension, and prints what the agent can now do: the tools, the
 * commands, and what each of them is for.
 *
 * Run: pnpm --filter @cli-agent/cli demo:extensions
 */

import { createSession } from "../src/session.js";

const cwd = process.argv[2] ?? process.cwd();

const session = await createSession({
  model: "test/never-called",
  cwd,
  permissionMode: "yolo",
  // A provider that is never asked: the demo is about what the agent can
  // do, not about what it says.
  provider: {
    id: "test",
    models: async () => [],
    async *stream() {
      yield {
        t: "done",
        usage: { inputTokens: 0, outputTokens: 0 },
        stop: "end",
      };
    },
  },
});

console.log("the tools the model may call:\n");
for (const tool of session.tools) {
  const description = tool.description.trim().split("\n")[0] ?? "";
  console.log(`  ${tool.name.padEnd(18)} ${description}`);
}

console.log("\nthe commands the user may type:\n");
for (const command of session.commands) {
  console.log(`  ${command.name.padEnd(18)} ${command.description ?? ""}`);
}

console.log("\nthe skills the model may load:\n");
for (const skill of session.skills) {
  console.log(`  ${skill.name.padEnd(18)} ${skill.description ?? ""}`);
}

console.log("\nthe hooks that run:\n");
for (const [event, hooks] of Object.entries(session.state.hooks?.definitions ?? {})) {
  for (const hook of hooks ?? []) {
    console.log(`  ${event.padEnd(18)} ${hook.command}`);
  }
}

console.log("\nthe MCP servers:");
for (const server of session.mcp.servers) {
  console.log(`  ${server.name}: ${server.tools.length} tools`);
}
for (const problem of session.mcp.problems) {
  console.log(`  ${problem.server}: ${problem.message}`);
}

console.log("\nthe extensions:");
for (const log of session.extensions.logs) {
  console.log(`  ${log}`);
}
for (const problem of session.extensions.problems) {
  console.log(`  ${problem.path}: ${problem.message}`);
}

// The MCP servers are processes: they have to be stopped, or this script
// never finishes.
await session.close();
