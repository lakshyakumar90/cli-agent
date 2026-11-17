import { describe, expect, it } from "vitest";
import { PermissionController } from "./controller.js";
import { withPermissions } from "./wrap.js";
import { z } from "zod";

describe("live permissions", () => {
  it("applies each mode change to existing tool wrappers", async () => {
    let calls = 0;
    const controller = new PermissionController({ mode: "plan" });
    const [tool] = withPermissions(
      [
        {
          name: "write",
          effect: "write",
          description: "write",
          schema: z.object({}),
          async run() {
            calls++;
            return { output: "written" };
          },
        },
      ],
      { mode: "plan", controller },
    );
    const ctx = { cwd: process.cwd(), signal: new AbortController().signal };
    expect((await tool!.run({}, ctx)).isError).toBe(true);
    controller.setMode("auto-edit");
    await tool!.run({}, ctx);
    expect(calls).toBe(1);
    controller.setMode("plan");
    await tool!.run({}, ctx);
    expect(calls).toBe(1);
  });
  it("keeps grants literal, even when commands contain glob characters", async () => {
    const controller = new PermissionController({ mode: "ask" });
    const signal = new AbortController().signal;
    const request = {
      tool: "bash",
      effect: "execute" as const,
      subject: "echo *",
      args: { command: "echo *" },
      reason: "run",
    };
    const first = controller.authorize(request, signal);
    controller.pending.values().next().value!.resolve("allow-always");
    expect(await first).toBe(true);
    expect(await controller.authorize(request, signal)).toBe(true);
    const other = controller.authorize(
      { ...request, subject: "echo secret", args: { command: "echo secret" } },
      signal,
    );
    expect(controller.pending.size).toBe(1);
    controller.reset();
    expect(await other).toBe(false);
  });
  it("cancels an approval once and rechecks queued requests on mode changes", async () => {
    const controller = new PermissionController({ mode: "ask" });
    const abort = new AbortController();
    const request = {
      tool: "write",
      effect: "write" as const,
      args: {},
      reason: "write",
    };
    const first = controller.authorize(request, abort.signal);
    const id = controller.pending.keys().next().value!;
    abort.abort();
    controller.answer(id, "allow");
    expect(await first).toBe(false);
    const next = controller.authorize(request, new AbortController().signal);
    controller.setMode("plan");
    expect(await next).toBe(false);
    expect(controller.pending.size).toBe(0);
  });
  it("does not bypass a deny rule in Full access or outside the workspace", async () => {
    const controller = new PermissionController({
      mode: "yolo",
      rules: [{ tool: "write", action: "deny" }],
    });
    expect(
      await controller.authorize(
        {
          tool: "write",
          effect: "write",
          args: {},
          reason: "write",
          outsideWorkspace: true,
        },
        new AbortController().signal,
      ),
    ).toBe(false);
  });
});
