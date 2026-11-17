import { spawn } from "node:child_process";

const t0 = Date.now();
const stamp = () => "+" + ((Date.now() - t0) / 1000).toFixed(1) + "s";

// Dump EVERYTHING the server writes, on both streams, to find the password.
const server = spawn("opencode", ["serve", "--port", "0"], {
  shell: true,
  env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { x: { mode: "primary" } } }) },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stdout.on("data", (c) => console.log(stamp(), "STDOUT>>", JSON.stringify(c.slice(0, 400))));
server.stderr.on("data", (c) => console.log(stamp(), "STDERR>>", JSON.stringify(c.slice(0, 400))));
server.on("close", (code) => console.log(stamp(), "server closed", code));

setTimeout(() => {
  server.kill();
  console.log(stamp(), "done");
  process.exit(0);
}, 30000).unref();
