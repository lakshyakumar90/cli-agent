import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool, detectShell, shorten, type Shell } from "./bash.js";
import { bubblewrapSandbox, dockerSandbox } from "./bash.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createTodoTool } from "./todo.js";
import type { ToolContext } from "./types.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-tools-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: directory,
    signal: new AbortController().signal,
    ...over,
  };
}

/** A command that waits, in whichever shell this machine has. */
function sleepCommand(seconds: number): string {
  const shell: Shell = detectShell();
  if (shell === "bash") return `sleep ${seconds}`;
  if (shell === "powershell") return `Start-Sleep -Seconds ${seconds}`;
  return `timeout /t ${seconds} /nul`;
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

describe("bash", () => {
  it("runs a command and returns its output", async () => {
    const result = await createBashTool().run(
      { command: "echo hello" },
      context(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("hello");
  });

  it("runs in the working directory", async () => {
    await writeFile(join(directory, "a.txt"), "content");

    const result = await createBashTool().run(
      { command: "cat a.txt" },
      context(),
    );

    expect(result.output).toContain("content");
  });

  it("reports a failure without throwing", async () => {
    const result = await createBashTool().run(
      { command: "exit 3" },
      context(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("exited with 3");
  });

  it("stops a command that runs too long", async () => {
    const result = await createBashTool({ timeoutMs: 300 }).run(
      { command: sleepCommand(10) },
      context(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("timed out");
  }, 20_000);

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const tool = createBashTool({ timeoutMs: 30_000 });

    // Wait until the command has really started, so the abort cannot land
    // before the child exists.
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const pending = tool.run(
      { command: `echo started && ${sleepCommand(10)}` },
      context({
        signal: controller.signal,
        onOutput: () => markStarted(),
      }),
    );

    await started;
    controller.abort();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("stopped");
  }, 20_000);

  it("streams the output as it arrives", async () => {
    const chunks: string[] = [];

    await createBashTool().run(
      { command: "echo one && echo two" },
      context({ onOutput: (text) => chunks.push(text) }),
    );

    expect(chunks.join("")).toContain("one");
    expect(chunks.join("")).toContain("two");
  });

  it("keeps the head and the tail of a long output", async () => {
    const result = await createBashTool({ maxOutput: 100 }).run(
      { command: "for i in $(seq 1 200); do echo 0123456789; done" },
      context(),
    );

    expect(result.output).toContain("characters omitted");
    expect(result.output.length).toBeLessThan(400);
  });

  it("shortens an output the way it says", () => {
    const output = "a".repeat(50) + "b".repeat(50);
    const short = shorten(output, 20);

    expect(short).toContain("characters omitted");
    expect(short.startsWith("a")).toBe(true);
    expect(short.endsWith("b")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// grep and glob
// ---------------------------------------------------------------------------

describe("grep", () => {
  it("finds the lines that match", async () => {
    await writeFile(join(directory, "a.txt"), "one\ntwo\nthree\n");
    await writeFile(join(directory, "b.txt"), "one again\n");

    const result = await createGrepTool().run(
      { pattern: "one" },
      context(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("a.txt:1:one");
    expect(result.output).toContain("b.txt:1:one again");
  });

  it("says when nothing matches", async () => {
    await writeFile(join(directory, "a.txt"), "one\n");

    const result = await createGrepTool().run(
      { pattern: "zzz" },
      context(),
    );

    expect(result.output).toContain("no matches");
  });

  it("can ignore the case", async () => {
    await writeFile(join(directory, "a.txt"), "ONE\n");

    const withCase = await createGrepTool().run(
      { pattern: "one" },
      context(),
    );
    expect(withCase.output).toContain("no matches");

    const withoutCase = await createGrepTool().run(
      { pattern: "one", ignore_case: true },
      context(),
    );
    expect(withoutCase.output).toContain("a.txt:1:ONE");
  });

  it("skips what git ignores", async () => {
    await writeFile(join(directory, ".gitignore"), "ignored.txt\n");
    await writeFile(join(directory, "ignored.txt"), "secret\n");
    await writeFile(join(directory, "kept.txt"), "secret\n");

    const result = await createGrepTool().run(
      { pattern: "secret" },
      context(),
    );

    expect(result.output).toContain("kept.txt");
    expect(result.output).not.toContain("ignored.txt");
  });

  it("reports a broken pattern", async () => {
    const result = await createGrepTool().run(
      { pattern: "([unclosed" },
      context(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("cannot search");
  });
});

describe("glob", () => {
  it("finds the files that match", async () => {
    await writeFile(join(directory, "a.ts"), "");
    await writeFile(join(directory, "b.md"), "");

    const result = await createGlobTool().run(
      { pattern: "*.ts" },
      context(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("a.ts");
    expect(result.output).not.toContain("b.md");
  });

  it("says when nothing matches", async () => {
    const result = await createGlobTool().run(
      { pattern: "*.nope" },
      context(),
    );

    expect(result.output).toContain("no files match");
  });

  it("skips what git ignores", async () => {
    await writeFile(join(directory, ".gitignore"), "build/\n");
    await writeFile(join(directory, "a.ts"), "");
    await mkdir(join(directory, "build"), { recursive: true });
    await writeFile(join(directory, "build", "b.ts"), "");

    const result = await createGlobTool().run(
      { pattern: "**/*.ts" },
      context(),
    );

    expect(result.output).toContain("a.ts");
    expect(result.output).not.toContain("build");
  });
});

// ---------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------

describe("the sandbox", () => {
  it("wraps the command in the program it names", async () => {
    const sandbox = {
      wrap(command: string): [string, string[]] {
        return [
          process.execPath,
          ["-e", `console.log("sandbox: " + ${JSON.stringify(command)})`],
        ];
      },
    };

    const result = await createBashTool({ sandbox }).run(
      { command: "echo hi" },
      context(),
    );

    expect(result.output).toContain("sandbox: echo hi");
  });

  it("builds a docker command line", () => {
    const [command, args] = dockerSandbox({ image: "node:22" }).wrap(
      "npm test",
      "/work/project",
    );

    expect(command).toBe("docker");
    expect(args).toContain("run");
    expect(args).toContain("--rm");
    expect(args).toContain("/work/project:/work");
    expect(args).toContain("node:22");
    expect(args[args.length - 1]).toBe("npm test");
  });

  it("builds a bubblewrap command line", () => {
    const [command, args] = bubblewrapSandbox().wrap(
      "npm test",
      "/work/project",
    );

    expect(command).toBe("bwrap");
    expect(args).toContain("--unshare-all");
    expect(args).toContain("/work/project");
    expect(args[args.length - 1]).toBe("npm test");
  });
});

// ---------------------------------------------------------------------------
// todo
// ---------------------------------------------------------------------------

describe("todo", () => {
  it("starts empty", async () => {
    const result = await createTodoTool().run({}, context());

    expect(result.output).toContain("empty");
  });

  it("keeps the list the model writes", async () => {
    const tool = createTodoTool();

    await tool.run(
      {
        todos: [
          { content: "read the file", status: "completed" },
          { content: "fix the bug", status: "in_progress" },
          { content: "run the tests", status: "pending" },
        ],
      },
      context(),
    );

    const result = await tool.run({}, context());

    expect(result.output).toContain("[x] read the file");
    expect(result.output).toContain("[>] fix the bug");
    expect(result.output).toContain("[ ] run the tests");
    expect(result.output).toContain("1 of 3 done");
  });

  it("replaces the list when the model rewrites it", async () => {
    const tool = createTodoTool();

    await tool.run(
      { todos: [{ content: "one", status: "pending" }] },
      context(),
    );
    await tool.run(
      { todos: [{ content: "two", status: "pending" }] },
      context(),
    );

    const result = await tool.run({}, context());

    expect(result.output).toContain("[ ] two");
    expect(result.output).not.toContain("[ ] one");
  });
});


