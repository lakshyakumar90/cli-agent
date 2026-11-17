import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createState, SessionStore, WorkerManager } from "@cli-agent/core";
import { PermissionController } from "@cli-agent/tools";
import { SessionController } from "./session-controller.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
describe("session switching", () => {
  it("restores model and usage and writes to the selected journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-controller-"));
    directories.push(root);
    const store = new SessionStore({ root, cwd: root });
    const provider = { id: "test", models: async () => [], async *stream() {} };
    const workerManager = new WorkerManager({
      cwd: root,
      roles: new Map(),
      tools: [],
      defaultModel: "test/a",
      providerFor: async () => provider,
    });
    const state = createState(provider, { model: "a", journal: store });
    const controller = new SessionController({
      state,
      store,
      workerManager,
      permissions: new PermissionController({ mode: "ask" }),
      model: "test/a",
      providerFor: async () => provider,
    });
    const a = await store.create({ model: "test/a" });
    await store.append({ role: "user", content: "original" });
    await store.append({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    await controller.create();
    const b = store.id!;
    await controller.setModel("test/b", provider);
    controller.recordModelChange("test/a", "test/b");
    await controller.save();
    await controller.open(a);
    expect(state.model).toBe("a");
    expect(controller.usage.inputTokens).toBe(12);
    await state.journal!.append({ role: "user", content: "follow-up" });
    expect((await store.transcript(a)).at(-1)?.content).toBe("follow-up");
    expect(await store.transcript(b)).toEqual([]);
    const oldModel = controller.model;
    controller.options.providerFor = async () => {
      throw new Error("unavailable");
    };
    await expect(controller.open(b)).rejects.toThrow("unavailable");
    expect(store.id).toBe(a);
    expect(controller.model).toBe(oldModel);
    controller.options.providerFor = async () => provider;
    await controller.open(b);
    expect(controller.modelChanges).toEqual([
      { after: 0, from: "test/a", to: "test/b" },
    ]);
  });
});
