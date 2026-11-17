import { describe, expect, it, vi } from "vitest";
import { WorkerManager } from "./worker-manager.js";
import type { Event, Provider } from "@cli-agent/ai";

describe("live workers", () => {
  it("cancels queued and running workers and releases concurrency slots", async () => {
    const provider: Provider = {
      id: "test",
      models: async () => [],
      async *stream(request): AsyncGenerator<Event> {
        yield { t: "text", delta: "working" };
        request.signal.throwIfAborted();
        await new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        request.signal.throwIfAborted();
      },
    };
    const manager = new WorkerManager({
      roles: new Map([
        ["reader", { name: "reader", prompt: "read", tools: [] }],
      ]),
      providerFor: async () => provider,
      defaultModel: "test/model",
      tools: [],
      cwd: process.cwd(),
      concurrency: 1,
    });
    const first = manager.start("reader", "one");
    await vi.waitFor(() => expect(manager.active[0]?.status).toBe("running"));
    const second = manager.start("reader", "two");
    expect(manager.active[1]?.status).toBe("queued");
    manager.stop(manager.active[1]!.id);
    expect((await second).status).toBe("cancelled");
    await manager.stopAll();
    expect((await first).status).toBe("cancelled");
    expect(manager.active).toHaveLength(0);
  });
  it("resumes the same worker with its previous conversation", async () => {
    const histories: number[] = [];
    const provider: Provider = {
      id: "test",
      models: async () => [],
      async *stream(request) {
        histories.push(request.messages.length);
        yield { t: "text", delta: "report" };
        yield {
          t: "done",
          stop: "end",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const manager = new WorkerManager({
      roles: new Map([
        ["reader", { name: "reader", prompt: "read", tools: [] }],
      ]),
      providerFor: async () => provider,
      defaultModel: "test/model",
      tools: [],
      cwd: process.cwd(),
    });
    const record = await manager.start("reader", "first");
    const again = await manager.followUp(record.id, "continue");
    expect(again.id).toBe(record.id);
    expect(histories[1]).toBeGreaterThan(histories[0]!);
    expect(again.runNumber).toBe(2);
    const restored = { ...again, status: "running" as const };
    manager.restore([restored]);
    expect(manager.records.get(record.id)?.status).toBe("interrupted");
  });
});
