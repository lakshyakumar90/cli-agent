import { spawn } from "node:child_process";

const t0 = Date.now();
const stamp = () => "+" + ((Date.now() - t0) / 1000).toFixed(1) + "s";

const AGENT = "cli-agent-host";
const config = JSON.stringify({
  agent: {
    [AGENT]: {
      description: "Driven by an external host",
      mode: "primary",
      tools: {
        bash: false,
        edit: false,
        write: false,
        read: false,
        grep: false,
        glob: false,
        webfetch: false,
        websearch: false,
        todowrite: false,
        todoread: false,
        task: false,
      },
    },
  },
});

function runCli(label, args, env, stdinText, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("opencode", args, {
      shell: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      for (const l of c.split("\n").filter((x) => x.trim()).slice(0, 6)) {
        let ev;
        try {
          ev = JSON.parse(l);
        } catch {
          console.log(stamp(), label, "RAW", l.slice(0, 120));
          continue;
        }
        const p = ev.part;
        if (p?.type === "text" && p.text)
          console.log(stamp(), label, "TEXT:", JSON.stringify(p.text.slice(0, 90)));
        if (p?.type === "tool") console.log(stamp(), label, "NATIVE TOOL!", JSON.stringify(p).slice(0, 120));
        if (ev.type === "error") console.log(stamp(), label, "ERROR", JSON.stringify(ev.error).slice(0, 200));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      for (const l of c.split("\n").filter((x) => x.trim()).slice(0, 3))
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
  console.log(stamp(), "=== private server, CONFIG agent (no plugin) ===");
  const server = spawn("opencode", ["serve", "--port", "0"], {
    shell: true,
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: config },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (c) => {
    for (const l of c.split("\n").filter((x) => x.trim()).slice(0, 3))
      console.log(stamp(), "SERVER ERR", l.slice(0, 140));
  });
  let buf = "";
  const info = await new Promise((resolve) => {
    server.stdout.on("data", (c) => {
      buf += c;
      const m = /server listening on (\S+)/.exec(buf);
      const p = /server password (\S+)/.exec(buf);
      if (m) console.log(stamp(), "SERVER LISTENING", m[1]);
      if (m && p) resolve({ url: m[1], password: p[1] });
    });
    setTimeout(() => resolve(undefined), 60000).unref();
  });
  console.log(stamp(), "server ready:", info ? info.url : "NO");

  if (info) {
    // 1. a plain question
    await runCli(
      "CONFIG-AGENT",
      ["run", "--server", info.url, "--model", "opencode/big-pickle", "--format", "json", "--thinking", "--agent", AGENT],
      { OPENCODE_PASSWORD: info.password },
      "Say only: PONG\n",
      60000,
    );
    // 2. does the catalog read fast from this server?
    const t1 = Date.now();
    await runCli(
      "CATALOG",
      ["models", "--server", info.url],
      { OPENCODE_PASSWORD: info.password },
      "",
      45000,
    );
    console.log(stamp(), "catalog took", ((Date.now() - t1) / 1000).toFixed(1) + "s");
  }

  server.kill();
  console.log(stamp(), "done");
}

main();
