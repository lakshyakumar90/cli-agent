import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const t0 = Date.now();
const stamp = () => "+" + ((Date.now() - t0) / 1000).toFixed(1) + "s";

function runCli(label, args, env, stdinText, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("opencode", args, {
      shell: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let firstOut = null;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      if (firstOut === null && c.trim()) {
        firstOut = Date.now();
        console.log(stamp(), label, "FIRST OUT");
      }
      for (const l of c.split("\n").filter((x) => x.trim()).slice(0, 3))
        console.log(stamp(), label, "OUT", l.slice(0, 150));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      for (const l of c.split("\n").filter((x) => x.trim()).slice(0, 3))
        console.log(stamp(), label, "ERR", l.slice(0, 150));
    });
    child.on("close", (code) => {
      console.log(stamp(), label, "CLOSED", code);
      resolve();
    });
    const timer = setTimeout(() => {
      console.log(stamp(), label, "TIMEOUT");
      child.kill();
    }, timeoutMs);
    timer.unref();
    child.stdin.end(stdinText);
  });
}

async function main() {
  // (a) private server with the guard plugin, like the provider does
  const dir = await mkdtemp(join(tmpdir(), "diag-guard-"));
  const agent = "cli-agent-guard-diag";
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "g", type: "module", exports: "./index.mjs" }),
  );
  await writeFile(
    join(dir, "index.mjs"),
    "export default { id: 'g', async setup(ctx) {\n" +
      "  await ctx.tool.hook('execute.before', async () => { throw new Error('no native tools'); });\n" +
      "  await ctx.tool.transform((editor) => { for (const t of editor.list()) editor.update(t.id, (i) => { i.execute = async () => { throw new Error('no native tools'); }; }); });\n" +
      "  await ctx.agent.transform((editor) => { const base = editor.get('build'); editor.update(" +
      JSON.stringify(agent) +
      ", (item) => Object.assign(item, structuredClone(base), { id: " +
      JSON.stringify(agent) +
      " })); });\n" +
      "} };\n",
  );
  const config = JSON.stringify({ plugins: [dir] });

  console.log(stamp(), "=== starting private server with guard plugin ===");
  const server = spawn("opencode", ["serve", "--port", "0"], {
    shell: true,
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: config },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (c) => {
    for (const l of c.split("\n").filter((x) => x.trim()).slice(0, 4))
      console.log(stamp(), "SERVER ERR", l.slice(0, 150));
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
  console.log(stamp(), "server url:", url);

  if (url !== undefined) {
    await runCli(
      "GUARD-RUN",
      ["run", "--server", url, "--model", "nvidia/deepseek-ai/deepseek-v4.1-flash", "--format", "json", "--agent", agent],
      {},
      "Say only: PONG\n",
      60000,
    );
  }

  server.kill();
  await rm(dir, { recursive: true, force: true });

  // (b) plain run against the machine's background service
  console.log(stamp(), "=== plain run (machine service) ===");
  await runCli(
    "PLAIN-RUN",
    ["run", "--model", "nvidia/deepseek-ai/deepseek-v4.1-flash", "--format", "json"],
    {},
    "Say only: PONG\n",
    60000,
  );

  console.log(stamp(), "done");
}

main();
