import { describe, expect, it } from "vitest";
import { z } from "zod";
import { run } from "./loop.js";
import { collect, scriptedProvider, stateWith } from "./loop.test-helpers.js";

/** A tool that changes a file, and remembers when it ran. */
function writingTool(name: string, order: string[], delayMs = 0): {
  name: string;
  description: string;
  schema: z.ZodType;
  effect: "write";
  run(args: any, ctx: any): Promise<{ output: string }>;
} {
  return {
    name,
    description: "Changes a file.",
    schema: z.object({ path: z.string() }),
    effect: "write",
    async run(args: any) {
      // The slower call finishes first, so a race would show.
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(args.path);
      return { output: `wrote ${args.path}` };
    },
  };
}

describe("the tools of one turn", () => {
  it("run one after another when they change things", async () => {
    const order: string[] = [];

    const provider = scriptedProvider([
      {
        calls: [
          { id: "c1", name: "write", args: { path: "a.ts" } },
          { id: "c2", name: "write", args: { path: "b.ts" } },
        ],
      },
      { text: "done" },
    ]);

    const state = stateWith(provider, [
      writingTool("write", order, 20),
    ]);

    await collect(run(state, "go", new AbortController().signal));

    // The order the model asked for is kept: a change that comes after
    // another change sees what it did.
    expect(order).toEqual(["a.ts", "b.ts"]);
  });

  it("run together when they only read", async () => {
    let running = 0;
    let peak = 0;

    const provider = scriptedProvider([
      {
        calls: [
          { id: "c1", name: "read", args: { path: "a.ts" } },
          { id: "c2", name: "read", args: { path: "b.ts" } },
          { id: "c3", name: "read", args: { path: "c.ts" } },
        ],
      },
      { text: "done" },
    ]);

    const state = stateWith(provider, [
      {
        name: "read",
        description: "Reads a file.",
        schema: z.object({ path: z.string() }),
        effect: "read" as const,
        async run() {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 20));
          running -= 1;
          return { output: "the file" };
        },
      },
    ]);

    await collect(run(state, "go", new AbortController().signal));

    // The reads went at the same time.
    expect(peak).toBe(3);
  });

  it("keep the order when a read comes after a change", async () => {
    const order: string[] = [];

    const provider = scriptedProvider([
      {
        calls: [
          { id: "c1", name: "write", args: { path: "a.ts" } },
          { id: "c2", name: "read", args: { path: "a.ts" } },
        ],
      },
      { text: "done" },
    ]);

    const state = stateWith(provider, [
      writingTool("write", order),
      {
        name: "read",
        description: "Reads a file.",
        schema: z.object({ path: z.string() }),
        effect: "read" as const,
        async run(args: any) {
          order.push(`read ${args.path}`);
          return { output: "the file" };
        },
      },
    ]);

    await collect(run(state, "go", new AbortController().signal));

    expect(order).toEqual(["a.ts", "read a.ts"]);
  });
});
