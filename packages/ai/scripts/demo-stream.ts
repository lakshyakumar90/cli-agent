/**
 * Phase 1 demo: one loop, two providers.
 *
 * The registry resolves a `"provider/model"` ref to a provider, and the same
 * `for await` loop streams from whichever backend it points at. With API keys
 * in the environment this talks to the real APIs; without them it falls back
 * to a local server that speaks both wire formats, so the code path is the
 * same either way.
 *
 * Run: pnpm --filter @cli-agent/ai demo:stream
 */

import { anthropic } from "../src/providers/anthropic.js";
import { openaiCompat } from "../src/providers/openai-compat.js";
import { ProviderRegistry } from "../src/registry.js";
import { startMockProviderServer } from "../src/testing/mock-providers.js";
import { estimateCost } from "../src/models.js";

const REFS = ["openai/gpt-5.5", "anthropic/claude-opus-5-5"];

async function buildRegistry(): Promise<{
  registry: ProviderRegistry;
  close: () => Promise<void>;
  note: string;
}> {
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (openaiKey !== undefined && anthropicKey !== undefined) {
    const registry = new ProviderRegistry();
    registry.register(
      openaiCompat({
        id: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: openaiKey,
      }),
    );
    registry.register(
      anthropic({
        id: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: anthropicKey,
      }),
    );
    return { registry, close: async () => undefined, note: "live APIs" };
  }

  const server = await startMockProviderServer({
    openai: "Hello from the OpenAI-compatible endpoint.",
    anthropic: "Hello from the Anthropic endpoint.",
    usage: { input: 42, output: 9 },
  });

  const registry = new ProviderRegistry();
  registry.register(
    openaiCompat({ id: "openai", baseUrl: `${server.url}/v1`, apiKey: "sk-demo" }),
  );
  registry.register(
    anthropic({
      id: "anthropic",
      baseUrl: `${server.url}/v1`,
      apiKey: "sk-ant-demo",
    }),
  );
  return {
    registry,
    close: () => server.close(),
    note: "local mock server (no API keys in the environment)",
  };
}

const { registry, close, note } = await buildRegistry();

console.log(`provider layer demo — backend: ${note}\n`);

for (const ref of REFS) {
  // The same three lines for every provider.
  const resolved = registry.resolve(ref);
  process.stdout.write(`${ref} -> `);

  let text = "";
  let usage: { inputTokens: number; outputTokens: number } | undefined;

  for await (const event of registry.stream(ref, {
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
  })) {
    if (event.t === "text") {
      text += event.delta;
      process.stdout.write(event.delta);
    }
    if (event.t === "done") usage = event.usage;
  }

  const cost = resolved.info !== undefined && usage !== undefined
    ? estimateCost(usage, resolved.info)
    : undefined;

  console.log(
    `\n  usage: ${usage?.inputTokens ?? 0} in / ${usage?.outputTokens ?? 0} out` +
      (cost === undefined ? "" : ` · est. $${cost.toFixed(6)}`),
  );
}

await close();
