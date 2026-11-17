import { spawn } from "node:child_process";

const t0 = Date.now();
const stamp = () => "+" + ((Date.now() - t0) / 1000).toFixed(1) + "s";

function runCli(label, args, env, stdinText, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("opencode", args, {
      shell: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      for (const l of c.split("\n").filter((x) => x.trim()).slice(0, 10)) {
        let ev;
        try {
          ev = JSON.parse(l);
        } catch {
          console.log(stamp(), label, "RAW", l.slice(0, 140));
          continue;
        }
        const p = ev.part;
        if (p?.type === "text" && p.text)
          console.log(stamp(), label, "TEXT:", JSON.stringify(p.text.slice(0, 100)));
        if (p?.type === "tool") console.log(stamp(), label, "NATIVE TOOL!");
        if (ev.type === "error") console.log(stamp(), label, "ERROR", JSON.stringify(ev.error).slice(0, 200));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      for (const l of c.split("\n").filter((x) => x.trim()).slice(0, 4))
        console.log(stamp(), label, "ERR", l.slice(0, 200));
    });
    child.on("close", (code) => {
      console.log(stamp(), label, "CLOSED", code);
      resolve();
    });
    setTimeout(() => {
      console.log(stamp(), label, "TIMEOUT");
      child.kill();
      resolve();
    }, timeoutMs).unref();
    child.stdin.end(stdinText);
  });
}

async function main() {
  console.log(stamp(), "=== ollama, plain CLI, no agent ===");
  await runCli(
    "OLLAMA-PLAIN",
    ["run", "--model", "ollama/llama3.2:latest", "--format", "json"],
    {},
    "Say only: PONG\n",
    120000,
  );

  console.log(stamp(), "=== ollama, with the host agent from config ===");
  const config = JSON.stringify({
    agent: {
      "cli-agent-host": {
        description: "Driven by an external host",
        mode: "primary",
        model: "ollama/llama3.2:latest",
        tools: { bash: false, edit: false, write: false, read: false, grep: false, glob: false },
      },
    },
  });
  await runCli(
    "OLLAMA-AGENT",
    ["run", "--model", "ollama/llama3.2:latest", "--format", "json", "--agent", "cli-agent-host"],
    { OPENCODE_CONFIG_CONTENT: config },
    "Say only: PONG\n",
    120000,
  );

  console.log(stamp(), "done");
  process.exit(0);
}

main();
