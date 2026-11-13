/**
 * Phase 3 demo: the agent, the tools and the permissions.
 *
 * A small project with a failing test. The agent reads the test, fixes the
 * code and runs the test again — with the permission layer in front of the
 * tools, in "ask" mode: the commands are allowed by a rule, and anything
 * else would be put to the user.
 *
 * Run: pnpm --filter @cli-agent/core demo:permissions
 * Needs GEMINI_API_KEY (or OPENAI_API_KEY).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gemini, openaiCompat } from "@cli-agent/ai";
import { createTools, parseRules, withPermissions } from "@cli-agent/tools";
import { createState, run } from "../src/index.js";
import { createSampleRepo, SAMPLE_TEST_COMMAND } from "../src/sample-repo.js";

const workspace = await mkdtemp(join(tmpdir(), "cli-agent-perms-"));
const repo = await createSampleRepo(workspace);

const geminiKey = process.env.GEMINI_API_KEY?.trim();
const openaiKey = process.env.OPENAI_API_KEY?.trim();

const provider =
  geminiKey !== undefined && geminiKey.length > 0
    ? gemini({ apiKey: geminiKey })
    : openaiCompat({
        id: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: openaiKey ?? "",
      });

const model = geminiKey !== undefined ? "gemini-2.5-flash" : "gpt-5.5";

const tools = withPermissions(createTools(), {
  mode: "ask",
  workspace: repo.dir,
  // The test command is allowed without asking; anything else would be.
  rules: parseRules(`bash(${SAMPLE_TEST_COMMAND}) allow`),
  ask: async (request) => {
    console.log(`\n[permission] ${request.reason}`);
    return "allow";
  },
});

const state = createState(provider, {
  model,
  tools,
  system:
    "You are a coding agent. Read the failing test, fix the code, then run the test to check your work.",
  cwd: repo.dir,
});

for await (const event of run(
  state,
  "The test in sum.test.mjs fails. Fix sum.mjs and run the test again.",
  new AbortController().signal,
)) {
  switch (event.t) {
    case "text":
      process.stdout.write(event.delta);
      break;
    case "toolStart":
      console.log(`\n> ${event.call.name}(${JSON.stringify(event.call.args)})`);
      break;
    case "toolEnd":
      console.log(`< ${event.call.name}: ${event.output.split("\n")[0]}`);
      break;
    case "done":
      console.log(
        `\n[done] reason=${event.reason} turns=${event.turns} usage=${event.usage.inputTokens} in / ${event.usage.outputTokens} out`,
      );
      break;
  }
}

console.log("\n--- sum.mjs now ---");
console.log(await readFile(repo.source, "utf8"));

await rm(workspace, { recursive: true, force: true });
