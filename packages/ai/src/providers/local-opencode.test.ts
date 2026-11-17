import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ProviderError } from "../errors.js";
import type { Event, Provider } from "../types.js";
import { localOpencode, guardedConfig } from "./local-opencode.js";

// ---------------------------------------------------------------------------
// A fake opencode CLI: reads the prompt from stdin, prints JSONL events.
// ---------------------------------------------------------------------------

const FAKE_CLI = `
import fs from 'node:fs';
const args = process.argv.slice(2);
const seen = process.env.OPENCODE_CONFIG_SEEN;

async function serve() {
  // A private server of our own: it says where it listens, and stays up.
  // The configuration it was started with is written down, so the test can
  // see what the server was given.
  if (seen) fs.writeFileSync(seen, process.env.OPENCODE_CONFIG_CONTENT || '');
  console.log("server listening on http://127.0.0.1:45999");
  // A server that was given no password to ask for never says one: the
  // bridge must not wait for a line that will not come.
  if (!process.env.OPENCODE_NO_PASSWORD) console.log("server password test-password");
  setInterval(() => {}, 1000);
}function catalog() {
  if (args.includes('cold-catalog')) {
    const file = args[args.indexOf('cold-catalog')+1];
    const count = fs.existsSync(file) ? Number(fs.readFileSync(file,'utf8')) : 0;
    fs.writeFileSync(file,String(count+1));
    if (!count) {
      // The way the real CLI says it: the message is on the first line and
      // the stack is under it. The message is what tells one failure from
      // another, so it must not be lost.
      console.error('ServiceUnavailableError: Location plugins did not finish activating');
      console.error('    at k (B:/~BUN/root/chunk-aav0azz9.js:13:33548)');
      console.error('    at <anonymous> (B:/~BUN/root/chunk-aav0azz9.js:2:1153)');
      console.error('    at cli.models (B:/~BUN/root/chunk-5nv4x58q.js:7:21996)');
      process.exit(1);
    }
  }
  console.log("opencode/big-pickle");
  console.log("nvidia/openai/gpt-oss-20b");
  console.log("not a model line");
  process.exit(0);
}

function turn() {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { stdin += chunk; });
  process.stdin.on("end", () => {
    if (args.includes("fail")) {
      console.error("something went wrong");
      process.exit(1);
    }
    if (args.includes("signed-out")) {
      // The way the real CLI says it has no login for the model asked for.
      console.error('auth: no credentials for "opencode"');
      process.exit(1);
    }
    if (args.includes("no-server")) {
      // The private server could not be started: the turn must fall back to
      // a server of its own, and it must say so.
      if (args.includes("--server")) process.exit(6);
    }
    if (args.includes("json-error")) {
      console.log(JSON.stringify({type:"error",error:{message:"Free usage limit reached",status:429}})); return;
    }
    if (args.includes("empty")) return;
    if (args.includes("config-preserved")) {
      const config = JSON.parse(seen ? fs.readFileSync(seen, 'utf8') : '{}');
      const agent = config.agent && config.agent['cli-agent-host'];
      if (config.model !== 'existing/model' || config.plugins[0] !== 'existing-plugin' || !agent) process.exit(4);
      if (agent.tools.bash !== false || agent.tools.read !== false) process.exit(4);
    }
    if (args.includes("silent")) { setInterval(() => {}, 1000); return; }
    if (args.includes("fragmented")) {
      const line = JSON.stringify({part:{id:"split",type:"text",text:"Hello 🌍"}});
      process.stdout.write(line.slice(0, 20));
      setTimeout(() => process.stdout.write(line.slice(20)), 30); return;
    }
    if (args.includes("external-tool")) {
      const config = JSON.parse(seen ? fs.readFileSync(seen, 'utf8') : '{}');
      const agent = config.agent && config.agent['cli-agent-host'];
      const selected = args[args.indexOf('--agent')+1];
      // The host agent is defined in the configuration, and every native
      // tool of it is off.
      if (!args.includes("--server") || !args.includes("--thinking") || selected !== 'cli-agent-host') process.exit(2);
      if (!agent || agent.tools.bash !== false || agent.tools.write !== false) process.exit(2);
      if (!stdin.includes('"name":"read"') || !stdin.includes('old-call')) process.exit(3);
      console.log(JSON.stringify({part:{id:"tool",type:"text",text:'<tool_call>\\n<cli-agent-tool>{"name":"read","args":{"path":"README.md"}}</cli-agent-tool>'}})); return;
    }
    console.log("> build · " + (args[args.indexOf("--model") + 1] || "?"));
    console.log(JSON.stringify({ type: "step_start" }));
    console.log(JSON.stringify({
      type: "text",
      part: { type: "text", text: "Hello from the CLI. [" + stdin.trim() + "]" },
    }));
    if (args.includes("hang")) {
      // Stay alive so the caller can abort mid-turn.
      setInterval(() => {}, 1000);
      return;
    }
    console.log(JSON.stringify({
      type: "step_finish",
      part: {
        type: "step-finish",
        reason: "stop",
        tokens: { input: 12, output: 3, cache: { read: 4, write: 0 } },
      },
    }));
  });
}

if (args.includes("serve")) {
  const counter = process.env.OPENCODE_SERVE_COUNT;
  if (counter) {
    const before = fs.existsSync(counter) ? Number(fs.readFileSync(counter,'utf8')) : 0;
    fs.writeFileSync(counter, String(before + 1));
  }
  if (process.env.OPENCODE_SERVE_FAILS) {
    // A server that cannot start: the bridge must give up on it once,
    // and not wait for it again on every turn.
    console.error("the private server cannot start");
    process.exit(1);
  }
  serve();
} else if (args.includes("models")) catalog();
else turn();
`;

let directory: string;
let script: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-opencode-"));
  script = join(directory, "fake-opencode.mjs");
  await writeFile(script, FAKE_CLI, "utf8");
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Every provider made by the test, so their servers are stopped again. */
const opened: Provider[] = [];

afterEach(async () => {
  while (opened.length > 0) {
    const made = opened.pop();
    await made?.close?.();
  }
  delete process.env.OPENCODE_CONFIG_SEEN;
});

function provider(over: Record<string, unknown> = {}) {
  const made = localOpencode({
    command: process.execPath,
    args: [script],
    ...over,
  });
  opened.push(made);
  return made;
}

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const collected: Event[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("local opencode", () => {
  it("starts one private server for the whole session", async () => {
    const counter = join(directory, "serve-count");
    process.env.OPENCODE_SERVE_COUNT = counter;
    const made = provider();

    await collect(made.stream(request("one")));
    await collect(made.stream(request("two")));
    await made.models();

    // The server is started once, not once per turn: a fresh one for every
    // turn costs several seconds before the model is even asked.
    expect(Number(await readFile(counter, "utf8"))).toBe(1);
  });

  it("uses a private server that asks for no password", async () => {
    // Most servers do not print a password at all: waiting for that line
    // would cost the whole timeout on every machine whose server has none.
    process.env.OPENCODE_NO_PASSWORD = "1";
    try {
      const events = await collect(provider().stream(request("one")));
      expect(events[0]).toMatchObject({ t: "text" });
      expect(events.at(-1)).toMatchObject({ t: "done" });
    } finally {
      delete process.env.OPENCODE_NO_PASSWORD;
    }
  });

  it("does not wait for a private server that cannot start, twice", async () => {
    const counter = join(directory, "serve-fail-count");
    process.env.OPENCODE_SERVE_COUNT = counter;
    process.env.OPENCODE_SERVE_FAILS = "1";
    try {
      const made = provider({ args: [script, "no-server"] });

      // The turn still runs: the CLI brings a server of its own.
      const first = await collect(made.stream(request("one")));
      expect(first[0]).toMatchObject({ t: "text" });

      // The server that cannot start is not asked for again: waiting for it
      // on every turn is what made the agent feel slow.
      await collect(made.stream(request("two")));
      expect(Number(await readFile(counter, "utf8"))).toBe(1);
    } finally {
      delete process.env.OPENCODE_SERVE_FAILS;
      delete process.env.OPENCODE_SERVE_COUNT;
    }
  });

  it("translates a refused native call into a call of the host", async () => {
    // A model that cannot reach a tool sends the call in the way it knows:
    // a call of its own, with the name of the tool. The CLI refuses it —
    // the agent of the host has every native tool turned off — and the
    // host runs it under its own permissions.
    const native = join(directory, "native-tool.mjs");
    await writeFile(
      native,
      `console.log(JSON.stringify({type:'tool_use',part:{type:'tool',id:'call-1',tool:'read',state:{status:'error',input:{path:'README.md'},error:'No tool named "read" is currently available.'}}}));
       console.log(JSON.stringify({type:'text',part:{id:'t1',type:'text',text:'done'}}));
       console.log(JSON.stringify({type:'step_finish',part:{type:'step-finish',reason:'tool-calls',tokens:{input:1,output:1}}}));`,
      "utf8",
    );

    const events = await collect(
      localOpencode({
        command: process.execPath,
        args: [native],
      }).stream({
        model: "model",
        system: "",
        messages: [],
        tools: [
          {
            name: "read",
            description: "Read a file",
            schema: { type: "object" },
          },
        ],
        signal: new AbortController().signal,
      }),
    );

    expect(
      events.find((event) => event.t === "toolCall"),
    ).toMatchObject({
      t: "toolCall",
      call: { name: "read", args: { path: "README.md" } },
    });
    expect(events.at(-1)).toMatchObject({ t: "done", stop: "tool" });
  });

  it("reads the call out of the arguments of a call the model made up", async () => {
    // Some models put the whole call in the arguments of a call they made
    // up, with the name of the tag as the name of the tool.
    const native = join(directory, "native-tool-2.mjs");
    await writeFile(
      native,
      `console.log(JSON.stringify({type:'tool_use',part:{type:'tool',id:'call-1',tool:'cli-agent-tool',state:{status:'error',input:{name:'read',args:'{"path": "C:\\\\Lakshya\\\\cli-agent\\\\README.md"}'},error:'No tool named "cli-agent-tool" is currently available.'}}}));
       console.log(JSON.stringify({type:'step_finish',part:{type:'step-finish',reason:'tool-calls',tokens:{input:1,output:1}}}));`,
      "utf8",
    );

    const events = await collect(
      localOpencode({
        command: process.execPath,
        args: [native],
      }).stream({
        model: "model",
        system: "",
        messages: [],
        tools: [
          {
            name: "read",
            description: "Read a file",
            schema: { type: "object" },
          },
        ],
        signal: new AbortController().signal,
      }),
    );

    expect(
      events.find((event) => event.t === "toolCall"),
    ).toMatchObject({
      t: "toolCall",
      call: { name: "read", args: { path: "C:\\Lakshya\\cli-agent\\README.md" } },
    });
  });

  it("says where the CLI was looked for when it is not there", async () => {
    const error = await localOpencode({
      command: join(directory, "no-such-opencode"),
      catalogBudgetMs: 500,
    })
      .models()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain("opencode CLI");
  });

  it("retries one cold OpenCode catalog activation failure", async () => {
    const models = await provider({
      args: [script, "cold-catalog", join(directory, "catalog-count")],
    }).models();
    expect(models).toHaveLength(2);
  });

  it("says the message of a cold catalog, and not only the stack under it", async () => {
    // The message of the failure is on the first line of the error stream.
    // When it is lost, the failure cannot be told from any other one, and
    // the catalogue says the OpenCode is unavailable.
    const failing = join(directory, "failing-catalog.mjs");
    await writeFile(
      failing,
      `console.error('ServiceUnavailableError: Location plugins did not finish activating');
       console.error('    at k (chunk.js:13:33548)');
       console.error('    at cli.models (chunk.js:7:21996)');
       process.exit(1);`,
      "utf8",
    );
    const error = await localOpencode({
      command: process.execPath,
      args: [failing],
      // The cold catalog is read again for a while; the message has to
      // survive every one of those tries.
      catalogBudgetMs: 2_000,
    })
      .models()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain(
      "Location plugins did not finish activating",
    );
  });
  it("defines the host agent in the configuration, with no native tool", () => {
    const previous = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      agent: { build: { model: "the/model-of-build" } },
    });
    try {
      const config = JSON.parse(guardedConfig("build").config);
      const agent = config.agent["cli-agent-host"];

      expect(agent).toBeDefined();
      // The profile of the named agent is kept: the model and the prompt.
      expect(agent.id).toBe("cli-agent-host");
      expect(agent.model).toBe("the/model-of-build");
      // Every native tool is off: the host runs the tools itself.
      expect(agent.tools.bash).toBe(false);
      expect(agent.tools.read).toBe(false);
      expect(agent.tools.write).toBe(false);
      expect(agent.tools.edit).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previous;
    }
  });

  it("keeps the configuration of the user and adds the host agent to it", () => {
    const previous = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: "existing/model",
      agent: { build: { model: "the/model-of-build" } },
    });
    try {
      const config = JSON.parse(guardedConfig("build").config);
      expect(config.model).toBe("existing/model");
      // The user's own agents are still there.
      expect(config.agent.build.model).toBe("the/model-of-build");
      expect(config.agent["cli-agent-host"]).toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previous;
    }
  });

  it("refuses a configuration that is not an object", () => {
    const previous = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_CONTENT = "[]";
    try {
      expect(() => guardedConfig("build")).toThrow(
        "OPENCODE_CONFIG_CONTENT must be a JSON object",
      );
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previous;
    }
  });
  const request = (model: string) => ({
    model,
    system: "",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  });
  it("augments existing environment configuration instead of replacing it", async () => {
    const previous = process.env.OPENCODE_CONFIG_CONTENT;
    const seen = join(directory, `seen-${Date.now()}.json`);
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: "existing/model",
      plugins: ["existing-plugin"],
    });
    process.env.OPENCODE_CONFIG_SEEN = seen;
    try {
      expect(
        await collect(provider().stream(request("config-preserved"))),
      ).toContainEqual(expect.objectContaining({ t: "text" }));
      // The server was given the user's own configuration, and the guarded
      // agent was added to it.
      const config = JSON.parse(await readFile(seen, "utf8"));
      expect(config.model).toBe("existing/model");
      // The plugins of the user are theirs: the bridge adds an agent to the
      // configuration, it does not install anything of its own.
      expect(config.plugins).toEqual(["existing-plugin"]);
      expect(config.agent["cli-agent-host"]).toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previous;
    }
  });
  it("reassembles fragmented JSON and flushes a final line without a newline", async () => {
    const events = await collect(provider().stream(request("fragmented")));
    expect(events[0]).toEqual({ t: "text", delta: "Hello 🌍" });
  });
  it("surfaces JSON error events even when the child exits successfully", async () => {
    await expect(
      collect(provider().stream(request("json-error"))),
    ).rejects.toMatchObject({
      message: "opencode: Free usage limit reached",
      status: 429,
      retryable: false,
    });
  });
  it("rejects an empty successful response", async () => {
    await expect(collect(provider().stream(request("empty")))).rejects.toThrow(
      "without an answer",
    );
  });
  it("wakes the reader on timeout even with no output", async () => {
    await expect(
      collect(provider({ timeoutMs: 100 }).stream(request("silent"))),
    ).rejects.toThrow("timed out");
  });
  it("isolates native tools and translates external calls while preserving call history", async () => {
    process.env.OPENCODE_CONFIG_SEEN = join(directory, "seen-tools.json");
    const events = await collect(
      provider().stream({
        ...request("external-tool"),
        tools: [
          {
            name: "read",
            description: "Read a file",
            schema: { type: "object" },
          },
        ],
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "old-call",
                name: "read",
                args: { path: "old" },
              },
            ],
          },
          { role: "tool", callId: "old-call", content: "old result" },
        ],
      }),
    );
    expect(events[0]).toMatchObject({
      t: "toolCall",
      call: { name: "read", args: { path: "README.md" } },
    });
    expect(events.at(-1)).toMatchObject({ t: "done", stop: "tool" });
  });
  it("normalizes snapshots by part ID without removing legitimate repeated text", async () => {
    const snapshotScript = join(directory, "snapshots.mjs");
    await writeFile(
      snapshotScript,
      `process.stdin.resume(); process.stdin.on('end', () => {
      for (const part of [
        {id:'a',type:'text',text:'ha'}, {id:'a',type:'text',text:'haha'},
        {id:'a',type:'text',text:'haha'}, {id:'b',type:'text',text:'ha'},
        {id:'r',type:'reasoning',text:'why'}, {id:'r',type:'reasoning',text:'why now'},
        {id:'r',type:'reasoning',text:'why now'}
      ]) console.log(JSON.stringify({part}));
    });`,
      "utf8",
    );
    const events = await collect(
      localOpencode({
        command: process.execPath,
        args: [snapshotScript],
      }).stream({
        model: "model",
        system: "",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      }),
    );
    expect(
      events
        .filter((e) => e.t === "text")
        .map((e) => e.delta)
        .join(""),
    ).toBe("hahaha");
    expect(
      events
        .filter((e) => e.t === "thinking")
        .map((e) => e.delta)
        .join(""),
    ).toBe("why now");
  });
  it("streams the CLI's text and usage", async () => {
    const events = await collect(
      provider().stream({
        model: "opencode/big-pickle",
        system: "Be brief.",
        messages: [{ role: "user", content: "Say hello." }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      {
        t: "text",
        delta:
          "Hello from the CLI. [<system>\nBe brief.\n</system>\n\n<user>\nSay hello.\n</user>]",
      },
      {
        t: "done",
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 4,
          cacheWriteTokens: 0,
        },
        stop: "end",
      },
    ]);
  });

  it("passes the model through to the CLI", async () => {
    const events = await collect(
      provider().stream({
        model: "nvidia/openai/gpt-oss-20b",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );

    expect(events[0]?.t).toBe("text");
  });

  it("lists the models the CLI can serve", async () => {
    const models = await provider().models();

    expect(models).toEqual([
      { id: "opencode/big-pickle", provider: "opencode" },
      { id: "nvidia/openai/gpt-oss-20b", provider: "opencode" },
    ]);
  });

  it("reports a failing CLI as a provider error", async () => {
    const error = await collect(
      provider().stream({
        model: "fail",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: "opencode", code: "protocol" });
    expect((error as Error).message).toContain("something went wrong");
  });

  it("says how to sign in when the CLI has no login for the model", async () => {
    const error = await collect(
      provider({ args: [script, "signed-out"] }).stream({
        model: "opencode/iceman-free",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    // "no credentials" on its own leaves the user guessing what to run.
    expect((error as Error).message).toContain("opencode auth login");
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const stream = provider({ timeoutMs: 60_000 }).stream({
      model: "hang",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: controller.signal,
    });

    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.t).toBe("text");

    controller.abort();
    const error = await iterator.next().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "aborted" });
  });
});
