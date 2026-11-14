/**
 * The eval tasks.
 *
 * Each task is a small repository, a question, and a test that says
 * whether the agent did it. The repository is thrown away afterwards, so
 * the agent can do anything to it.
 *
 * The test is a command that runs in the repository: it exits with zero
 * when the work was done, and with something else when it was not. That
 * is the whole rule - a task passes or it does not.
 *
 * The solution is what a careful agent would do. The tests of the runner
 * play it back, so the tasks, the tests and the runner are all proved
 * to work without a model.
 */

/** One task. */
export interface EvalTask {
  /** Its name. */
  name: string;
  /** What the agent is asked. */
  prompt: string;
  /** The files the repository starts with. */
  files: Record<string, string>;
  /** The command that says whether the work was done. */
  test: string;
  /** What a careful agent would do. */
  solution: Array<{ tool: string; args: unknown }>;
}

/** The task that says the file is not there. */
const missing = (path: string): string =>
  `import { existsSync } from "node:fs";\n` +
  `if (existsSync(${JSON.stringify(path)})) {\n` +
  `  console.error(${JSON.stringify(`${path} is still there`)});\n` +
  `  process.exit(1);\n` +
  `}\n` +
  `console.log("ok");\n`;

/** The task that says the file is not what it should be. */
const wrong = (path: string, wanted: string[]): string =>
  `import { readFileSync } from "node:fs";\n` +
  `const text = readFileSync(${JSON.stringify(path)}, "utf8");\n` +
  `for (const part of ${JSON.stringify(wanted)}) {\n` +
  `  if (!text.includes(part)) {\n` +
  `    console.error(${JSON.stringify(path)} + " does not have " + part);\n` +
  `    process.exit(1);\n` +
  `  }\n` +
  `}\n` +
  `console.log("ok");\n`;

/** The tasks. */
export const EVAL_TASKS: EvalTask[] = [
  {
    name: "create a file",
    prompt:
      "Create a file called src/greeting.ts that exports a function " +
      "greet(name: string): string. It returns `Hello, ${name}!`.",
    files: {
      "check.mjs": wrong("src/greeting.ts", ["greet", "Hello"]),
      "README.md": "# A small project\n",
    },
    test: "node check.mjs",
    solution: [
      {
        tool: "write",
        args: {
          path: "src/greeting.ts",
          content:
            "export function greet(name: string): string {\n" +
            "  return `Hello, ${name}!`;\n" +
            "}\n",
        },
      },
    ],
  },

  {
    name: "fix a broken function",
    prompt:
      "The function add in src/math.ts is wrong: it subtracts. Make it add.",
    files: {
      "src/math.ts":
        "export function add(a: number, b: number): number {\n" +
        "  return a - b;\n" +
        "}\n",
      "check.mjs":
        "import { add } from './src/math.ts';\n" +
        "if (add(2, 3) !== 5) {\n" +
        "  console.error('add(2, 3) is not 5');\n" +
        "  process.exit(1);\n" +
        "}\n" +
        "console.log('ok');\n",
    },
    test: "node check.mjs",
    solution: [
      {
        tool: "edit",
        args: {
          path: "src/math.ts",
          old_string: "  return a - b;",
          new_string: "  return a + b;",
        },
      },
    ],
  },

  {
    name: "rename a function",
    prompt:
      "Rename the function oldName in src/api.ts to newName, everywhere it " +
      "is used.",
    files: {
      "src/api.ts":
        "export function oldName(): string {\n" +
        "  return 'hello';\n" +
        "}\n",
      "src/use.ts":
        "import { oldName } from './api.js';\n" +
        "console.log(oldName());\n",
      "check.mjs":
        "import { readFileSync } from 'node:fs';\n" +
        "const api = readFileSync('src/api.ts', 'utf8');\n" +
        "const use = readFileSync('src/use.ts', 'utf8');\n" +
        "if (!api.includes('newName')) {\n" +
        "  console.error('src/api.ts does not have newName');\n" +
        "  process.exit(1);\n" +
        "}\n" +
        "if (api.includes('oldName') || use.includes('oldName')) {\n" +
        "  console.error('oldName is still there');\n" +
        "  process.exit(1);\n" +
        "}\n" +
        "console.log('ok');\n",
    },
    test: "node check.mjs",
    solution: [
      {
        tool: "edit",
        args: {
          path: "src/api.ts",
          old_string: "export function oldName(): string {",
          new_string: "export function newName(): string {",
        },
      },
      {
        tool: "edit",
        args: {
          path: "src/use.ts",
          old_string: "import { oldName } from './api.js';",
          new_string: "import { newName } from './api.js';",
        },
      },
      {
        tool: "edit",
        args: {
          path: "src/use.ts",
          old_string: "console.log(oldName());",
          new_string: "console.log(newName());",
        },
      },
    ],
  },

  {
    name: "delete a file",
    prompt: "Delete the file obsolete.txt. It is not used any more.",
    files: {
      "obsolete.txt": "this is not used any more\n",
      "keep.txt": "this one is used\n",
      "check.mjs": missing("obsolete.txt"),
    },
    test: "node check.mjs",
    solution: [
      {
        tool: "bash",
        args: { command: "rm obsolete.txt" },
      },
    ],
  },

  {
    name: "replace every occurrence",
    prompt:
      "In src/app.txt, replace every occurrence of the word foo with bar.",
    files: {
      "src/app.txt": "foo one\ntwo foo\nfoo three foo\n",
      "check.mjs": wrong("src/app.txt", ["bar one", "two bar", "bar three bar"]),
    },
    test: "node check.mjs",
    solution: [
      {
        tool: "write",
        args: {
          path: "src/app.txt",
          content: "bar one\ntwo bar\nbar three bar\n",
        },
      },
    ],
  },

  {
    name: "fix a failing test",
    prompt:
      "The test fails. Make it pass, without changing what the test " +
      "checks.",
    files: {
      "package.json": '{\n  "name": "broken",\n  "type": "module"\n}\n',
      "double.js":
        "export function double(n) {\n" +
        "  return n * 3;\n" +
        "}\n",
      "double.test.mjs":
        "import { double } from './double.js';\n" +
        "import { test } from 'node:test';\n" +
        "import assert from 'node:assert';\n" +
        "test('double', () => {\n" +
        "  assert.equal(double(2), 4);\n" +
        "});\n",
      "check.mjs":
        "import { spawnSync } from 'node:child_process';\n" +
        "const result = spawnSync('node', ['--test'], { encoding: 'utf8' });\n" +
        "if (result.status !== 0) {\n" +
        "  console.error(result.stdout + result.stderr);\n" +
        "  process.exit(1);\n" +
        "}\n" +
        "console.log('ok');\n",
    },
    test: "node check.mjs",
    solution: [
      {
        tool: "edit",
        args: {
          path: "double.js",
          old_string: "  return n * 3;",
          new_string: "  return n * 2;",
        },
      },
    ],
  },

  {
    name: "sort a list",
    prompt:
      "Sort the names in data.json alphabetically and write the file " +
      "back.",
    files: {
      "data.json": '{\n  "names": ["delta", "alpha", "charlie", "bravo"]\n}\n',
      "check.mjs":
        "import { readFileSync } from 'node:fs';\n" +
        "const data = JSON.parse(readFileSync('data.json', 'utf8'));\n" +
        "const wanted = ['alpha', 'bravo', 'charlie', 'delta'];\n" +
        "if (JSON.stringify(data.names) !== JSON.stringify(wanted)) {\n" +
        "  console.error('the names are not sorted: ' + JSON.stringify(data.names));\n" +
        "  process.exit(1);\n" +
        "}\n" +
        "console.log('ok');\n",
    },
    test: "node check.mjs",
    solution: [
      {
        tool: "write",
        args: {
          path: "data.json",
          content:
            '{\n  "names": ["alpha", "bravo", "charlie", "delta"]\n}\n',
        },
      },
    ],
  },

  {
    name: "change a setting",
    prompt:
      "The server listens on port 3000 in src/config.ts. Make it listen " +
      "on port 8080.",
    files: {
      "src/config.ts":
        "export const PORT = 3000;\n",
      "check.mjs":
        "import { readFileSync } from 'node:fs';\n" +
        "const text = readFileSync('src/config.ts', 'utf8');\n" +
        "if (!text.includes('8080')) {\n" +
        "  console.error('the port is not 8080');\n" +
        "  process.exit(1);\n" +
        "}\n" +
        "console.log('ok');\n",
    },
    test: "node check.mjs",
    solution: [
      {
        tool: "edit",
        args: {
          path: "src/config.ts",
          old_string: "export const PORT = 3000;",
          new_string: "export const PORT = 8080;",
        },
      },
    ],
  },

  {
    name: "write a test",
    prompt:
      "Write a test for the function double in src/double.ts. It is in " +
      "test/double.test.mjs, and it runs with `node --test`.",
    files: {
      "package.json": '{\n  "name": "with-tests",\n  "type": "module"\n}\n',
      "src/double.ts":
        "export function double(n: number): number {\n" +
        "  return n * 2;\n" +
        "}\n",
      "check.mjs":
        "import { existsSync, readFileSync } from 'node:fs';\n" +
        "import { spawnSync } from 'node:child_process';\n" +
        "if (!existsSync('test/double.test.mjs')) {\n" +
        "  console.error('there is no test/double.test.mjs');\n" +
        "  process.exit(1);\n" +
        "}\n" +
        "const text = readFileSync('test/double.test.mjs', 'utf8');\n" +
        "if (!text.includes('double')) {\n" +
        "  console.error('the test does not mention double');\n" +
        "  process.exit(1);\n" +
        "}\n" +
        "const result = spawnSync('node', ['--test'], { encoding: 'utf8' });\n" +
        "if (result.status !== 0) {\n" +
        "  console.error(result.stdout + result.stderr);\n" +
        "  process.exit(1);\n" +
        "}\n" +
        "console.log('ok');\n",
    },
    test: "node check.mjs",
    solution: [
      {
        tool: "write",
        args: {
          path: "test/double.test.mjs",
          content:
            "import { double } from '../src/double.ts';\n" +
            "import { test } from 'node:test';\n" +
            "import assert from 'node:assert';\n" +
            "test('double', () => {\n" +
            "  assert.equal(double(2), 4);\n" +
            "});\n",
        },
      },
    ],
  },

  {
    name: "add a section to the readme",
    prompt:
      "Add a section '## Install' to README.md, saying that the project " +
      "is installed with `npm install`.",
    files: {
      "README.md": "# The project\n\nIt does things.\n",
      "check.mjs": wrong("README.md", ["## Install", "npm install"]),
    },
    test: "node check.mjs",
    solution: [
      {
        tool: "edit",
        args: {
          path: "README.md",
          old_string: "# The project\n\nIt does things.\n",
          new_string:
            "# The project\n\nIt does things.\n\n## Install\n\n" +
            "The project is installed with `npm install`.\n",
        },
      },
    ],
  },

  {
    name: "bump the version",
    prompt: "Set the version in package.json to 2.0.0.",
    files: {
      "package.json":
        '{\n  "name": "thing",\n  "version": "1.0.0",\n  "type": "module"\n}\n',
      "check.mjs":
        "import { readFileSync } from 'node:fs';\n" +
        "const pkg = JSON.parse(readFileSync('package.json', 'utf8'));\n" +
        "if (pkg.version !== '2.0.0') {\n" +
        "  console.error('the version is ' + pkg.version);\n" +
        "  process.exit(1);\n" +
        "}\n" +
        "console.log('ok');\n",
    },
    test: "node check.mjs",
    solution: [
      {
        tool: "edit",
        args: {
          path: "package.json",
          old_string: '"version": "1.0.0"',
          new_string: '"version": "2.0.0"',
        },
      },
    ],
  },

  {
    name: "find every place",
    prompt:
      "Find every place in src that uses the function logOld, and say which " +
      "files they are in.",
    files: {
      "src/a.ts":
        "import { logOld } from './log.js';\n" +
        "logOld('a');\n",
      "src/b.ts":
        "import { logOld } from './log.js';\n" +
        "logOld('b');\n",
      "src/c.ts": "export const c = 1;\n",
      "src/log.ts": "export function logOld(s: string) {}\n",
      "check.mjs":
        "import { readFileSync } from 'node:fs';\n" +
        "const a = readFileSync('src/a.ts', 'utf8');\n" +
        "const b = readFileSync('src/b.ts', 'utf8');\n" +
        "const c = readFileSync('src/c.ts', 'utf8');\n" +
        "if (!a.includes('logOld') || !b.includes('logOld')) {\n" +
        "  console.error('a place is missing');\n" +
        "  process.exit(1);\n" +
        "}\n" +
        "if (c.includes('logOld')) {\n" +
        "  console.error('c.ts does not use it');\n" +
        "  process.exit(1);\n" +
        "}\n" +
        "console.log('ok');\n",
    },
    test: "node check.mjs",
    solution: [
      {
        tool: "grep",
        args: { pattern: "logOld" },
      },
    ],
  },

  {
    name: "make a folder with a file in it",
    prompt:
      "Make a folder called docs and put a file called intro.md in it, " +
      "with the text 'Hello'.",
    files: {
      "check.mjs": wrong("docs/intro.md", ["Hello"]),
    },
    test: "node check.mjs",
    solution: [
      {
        tool: "write",
        args: { path: "docs/intro.md", content: "Hello\n" },
      },
    ],
  },

  {
    name: "add a trailing newline",
    prompt:
      "The file notes.txt does not end with a newline. Make it end with one.",
    files: {
      "notes.txt": "first line\nsecond line",
      "check.mjs":
        "import { readFileSync } from 'node:fs';\n" +
        "const text = readFileSync('notes.txt', 'utf8');\n" +
        "if (!text.endsWith('\\n')) {\n" +
        "  console.error('it does not end with a newline');\n" +
        "  process.exit(1);\n" +
        "}\n" +
        "console.log('ok');\n",
    },
    test: "node check.mjs",
    solution: [
      {
        tool: "edit",
        args: {
          path: "notes.txt",
          old_string: "first line\nsecond line",
          new_string: "first line\nsecond line\n",
        },
      },
    ],
  },
];
