import { spawn } from "node:child_process";

const started = Date.now();
const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;
console.log(stamp(), "start");

function run(label, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("opencode", args, {
      shell: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      buf += c;
      const lines = c.split("\n").filter((l) => l.trim());
      for (const l of lines.slice(0, 6))
        console.log(stamp(), label, "OUT", l.slice(0, 160));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      for (const l of c.split("\n").filter((l) => l.trim()).slice(0, 4))
        console.log(stamp(), label, "ERR", l.slice(0, 160));
    });
    child.on("close", (code) => {
      console.log(stamp(), label, "CLOSED", code);
      resolve();
    });
    setTimeout(() => {
      console.log(stamp(), label, "TIMEOUT-killing");
      child.kill();
    }, 45000).unref();
    child.stdin.end("Say only: PONG\n");
  });
}

await run("PLAIN-RUN", [
  "run",
  "--model",
  "nvidia/deepseek-ai/deepseek-v4.1-flash",
  "--format",
  "json",
  "--thinking",
]);
console.log(stamp(), "all done");
