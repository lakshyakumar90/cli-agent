/**
 * Phase 5 demo: the layered system prompt.
 *
 * Shows what the model is told on every turn, layer by layer, and which of
 * the layers the provider can cache.
 *
 * Run: pnpm --filter @cli-agent/core demo:prompt
 */

import { buildPromptLayers, buildSystemPrompt } from "../src/index.js";
import { createTools } from "@cli-agent/tools";

const cwd = process.cwd();

const layers = await buildPromptLayers({
  cwd,
  tools: createTools(),
  read: true,
  active: {
    plan: "read the failing test, fix the code, run the test",
    todo: ["read the test", "fix sum.mjs", "run node --test"],
  },
});

console.log("the layers, in the order they go into the prompt:\n");
for (const layer of layers) {
  const mark = layer.stable ? "stable  " : "changing";
  console.log(`[${mark}] ${layer.name}`);
}

console.log("\n--- the whole prompt ---\n");
console.log(await buildSystemPrompt({ cwd, tools: createTools(), read: true }));
