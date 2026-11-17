/**
 * Temporary diagnostic: compare the ways of driving the opencode CLI.
 * A: machine background service, plain agent.
 * B: machine background service, agent defined in config (no plugin).
 * C: private server, guard plugin (what the provider does today).
 * Delete when done.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

/** Run one turn and report when the first text arrives. */
function turn(label, args, env = {}, budget = 75000) {
  return new Promise((resolve) => {
    const child = spawn("opencode", args, {
      shell: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let firstText = null;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      for (const line of c.split("\n").filter((x) => x.trim())) {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          console.log(stamp(), label, "RAW", line.slice(0, 120));
          continue;
        }
        const part = ev.part;
        if (part?.type === "text" && part.text) {
          if (firstText === null) {
            firstText = Date.now() - t0;
            console.log(stamp(), label, "FIRST TEXT:", JSON.stringify(part.text.slice(0, 60)), `(${firstText}ms)`);
          }
        }
        if (part?.type === "tool")
          console.log(stamp(), label, "NATIVE TOOL", JSON.stringify(part.tool ?? part.state ?? part).slice(0, 100));
        if (ev.type === "error")
          console.log(stamp(), label, "ERROR EVENT", JSON.stringify(ev.error).slice(0, 160));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      for (const l of c.split("\n").filter((x) => x.trim()).slice(0, 3))
        console.log(stamp(), label, "ERR", l.slice(0, 160));
    });
    child.on("close", (code) => {
      console.log(stamp(), label, "CLOSED", code, firstText === null ? "(no text)" : "");
      resolve();
    });
    setTimeout(() => {
      console.log(stamp(), label, "TIMEOUT");
      child.kill();
      resolve();
    }, budget).unref();
    child.stdin.end("Say only: PONG\n");
  });
}

const MODEL = "nvidia/deepseek-ai/deepseek-v4.1-flash";

console.log(stamp(), "=== A: machine service, plain agent ===");
await turn("A", ["run", "--model", MODEL, "--format", "json"]);

console.log(stamp(), "=== B: machine service, agent from config ===");
await turn(
  "B",
  ["run", "--model", MODEL, "--format", "json", "--agent", "cli-agent-host"],
  {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      agent: {
        "cli-agent-host": {
          description: "Host-controlled agent",
          mode: "primary",
          tools: { bash: false, edit: false, write: false, read: false, webfetch: false },
        },
      },
    }),
  },
);

console.log(stamp(), "=== C: private server, guard plugin ===");
const dir = await mkdtemp(join(tmpdir(), "diag-guard-"));
await writeFile(join(dir, "package.json"), JSON.stringify({ name: "g", type: "module", exports: "./index.mjs" }));
await writeFile(
  join(dir, "index.mjs"),
  `export default { id: "g", async setup(ctx) {
     await ctx.tool.hook("execute.before", async () => { throw new Error("no native tools"); });
     await ctx.agent.transform((editor) => {
       const base = editor.get("build");
       editor.update("cli-agent-guard-diag", (item) => Object.assign(item, structuredClone(base), { id: "cli-agent-guard-diag" }));
     });
   }};`,
);
const server = spawn("opencode", ["serve", "--port", "0"], {
  shell: true,
  env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [dir] }) },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stderr.on("data", (c) => {
  for (const l of c.split("\n").filter((x) => x.trim()).slice(0, 3))
    console.log(stamp(), "SERVER ERR", l.slice(0, 160));
});
const url = await new Promise((resolve) => {
  server.stdout.on("data", (c) => {
    const m = /server listening on (\S+)/.exec(c);
    if (m) {
      console.log(stamp(), "SERVER LISTENING", m[1]);
      resolve(m[1]);
    }
  });
  setTimeout(() => resolve(undefined), 60000).unref();
});
if (url !== undefined) {
  await turn(
    "C",
    ["run", "--server", url, "--model", MODEL, "--format", "json", "--agent", "cli-agent-guard-diag"],
    {},
    75000,
  );
} else {
  console.log(stamp(), "SERVER DID NOT START");
}
server.kill();
await rm(dir, { recursive: true, force: true });
console.log(stamp(), "=== done ===");
