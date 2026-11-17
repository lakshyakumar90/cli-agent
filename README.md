# A coding agent, built from scratch

A coding agent that runs in the terminal: it reads a codebase, changes it,
runs the tests and explains what it did. It streams everything, keeps a
history you can go back to, and can hand parts of the job to other agents
that work on their own.

```
agent -p "find every place that writes to the database and list them"
```

## Website and documentation

The Next.js landing page lives in [`apps/web`](./apps/web/README.md). Run it locally:

```sh
pnpm --filter @cli-agent/web dev
```

Open http://localhost:3000 for the landing page and http://localhost:3000/docs for
installation, provider connectivity, permissions, sessions, workers, and the build
guide. The MDX docs include downloadable Mermaid diagrams and a searchable source
file reference. Build with `pnpm --filter @cli-agent/web build`.

Folder READMEs explain their local files. Refresh the generated maps after source
changes with `node scripts/document-repository.mjs --readmes`.

## What it does

- **Talk to several providers.** OpenAI, Anthropic, Gemini, Codex (ChatGPT),
  Antigravity (Google), OpenRouter, or the OpenCode CLI on your machine.
  One wire format is normalised into one stream of events.
- **Use tools.** `read`, `write`, `edit`, `bash`, `grep`, `glob` and a
  checklist. Every call is checked against your permission rules first.
- **Keep the context small.** It counts the tokens, compacts the old part of
  the conversation when the window fills up, and shrinks long tool output.
- **Remember.** Every session is written down as it happens, so you can quit
  in the middle of a task and pick it up again.
- **Delegate.** It can hand a job to another agent — an explorer, a coder, a
  reviewer — that works in its own context and reports back in a few lines.
- **Be extended.** MCP servers, skills, hooks, your own commands and your own
  TypeScript extensions all add behaviour without a fork.
- **Be watched.** Every request, tool call and usage is written down as JSONL,
  with the secrets taken out, and the status line says what the session has
  cost so far.
- **Be measured.** A suite of fourteen tasks, each in a throwaway repository
  with a test of its own, says how often the agent gets the job done and what
  it costs.

## Install and run

```sh
pnpm install
pnpm build
pnpm --filter @cli-agent/cli start          # interactive
pnpm --filter @cli-agent/cli start -p "..." # print the answer and exit
```

Requires Node 24 or newer.

To install it as a command:

```sh
cd packages/cli
npm pack
npm i -g ./cli-agent-cli-0.1.0.tgz
agent -p "what does this repository do?"
```

Or as one file that needs nothing installed:

```sh
pnpm --filter @cli-agent/cli build:binary   # packages/cli/agent
```

## The command line

```
agent                          start an interactive session
agent -p "prompt"              print the answer and exit
agent --json -p "prompt"       the events as JSON lines
agent --rpc                    read JSON lines, write JSON lines

  -p, --print <prompt>          the prompt to run
      --model <provider/model>  the model to use
      --cwd <dir>               the directory to work in
      --mode <mode>             ask | auto-edit | yolo | plan
      --allow <rule>            allow a call, e.g. "bash(git status) allow"
      --deny <rule>             refuse a call
      --ask <rule>              always ask about a call
      --json                    write the events as JSON lines
      --rpc                     read and write JSON lines
      --continue                carry on with the last session here
      --resume [id]             open a session (the newest one when none is named)
      --log <file>              where the log of the session goes
      --no-log                  write no log
  -v, --verbose                 show the tool activity
  -h, --help                    this text
```

With no `--model`, the agent uses **one of OpenRouter's free models** — the
one it picks from the free list that exists today. A key that is free to
use is a key that works.

`/model` shows only what you can pick: the providers you hold a credential
for, and for OpenRouter only the free ones. CLI-backed connections may appear without an agent-owned API key; their own
sign-in, installed executable, and account access still apply.

**The session opens even without a key.** It says what is missing and waits:
`/login` signs in, `/model` picks another provider.

In the interactive session:

| Key | What it does |
| --- | --- |
| `/model` | pick another model — a list, with the arrows |
| `/login` | sign in to a provider |
| `/compact` | summarise the conversation now |
| `/clear` | start the conversation over |
| `/resume` | open another session |
| `/fork` | branch the conversation from an earlier message |
| `/tree` | show the branches of the session |
| `/undo` | take back the last change |
| `/agents` | the agents it can delegate to |
| `/tasks` | live workers, transcripts, stop, follow-up, and resume |
| `/rename` | give the current session a name |
| `/review` | review uncommitted changes, a base branch, or a commit |
| `/diff` | inspect the working tree diff |
| `/help` | the commands, and where the log is |
| `?` | the keys |
| `@` then `Tab` | the files, in a list — the arrows move, `Enter` takes |
| `!command` | run a shell command |
| `Esc` | stop the turn |
| `Shift+Tab` | cycle Ask, Auto-edit, and Plan in place |
| `Alt+I` or `/inspect` | inspect the latest tool or thinking block |
| `Ctrl+O` | inspect the complete transcript |
| `Ctrl+B` | open worker controls |
| `Ctrl+R` | search prompt history |
| `Shift+Enter` / `Ctrl+J` | insert a newline |

The interactive UI uses pi's differential terminal renderer, with one editor
and focused selectors. Mode changes and progress update in place. Thinking
includes a bounded live preview; complete tool results remain available through
inspection. Full access (`yolo`) is available
through `/permissions` with explicit confirmation, or through `--mode yolo`.
It does not disable operating-system restrictions. Permission changes apply
to the main agent and its workers before their next tool execution.

Sessions are saved continuously. `/resume` switches the active journal and
restores the model and conversation together; `/clear` creates a new saved
conversation. Session grants are cleared when switching. Forks retain their
inherited history after restarting. Workers interrupted by process exit can
be inspected and resumed from `/tasks`.

`/review` runs with read-only tools and returns prioritized findings; it never
applies fixes. Its detail view includes the reviewed diff and flags stale or
incomplete results. Press `f` to draft a separate fix request. Worker detail
views use `s` to stop, `f` to queue a follow-up, and `r` to resume.

The session opens with a header — the model, the directory, how to change
the model — and a status line that says how much of the context is left,
what the session has cost, and how many turns it has taken. A spinner
turns where it is while the agent works.

## Signing in

The environment comes first, then the credentials in `~/.myagent/auth.json`:

```sh
export OPENAI_API_KEY=...        # or ANTHROPIC_API_KEY, GEMINI_API_KEY, ...
export CODEX_ACCESS_TOKEN=...    # or ANTIGRAVITY_ACCESS_TOKEN
```

For the OAuth providers, `/login` opens the browser and listens on a
temporary localhost address for the answer. The refresh token is stored and
used when the access token runs out. The client ids come from the
environment — `MYAGENT_CODEX_CLIENT_ID`, `MYAGENT_GOOGLE_CLIENT_ID` and
`MYAGENT_GOOGLE_CLIENT_SECRET` — so no vendor id is baked into the code.

**The CLIs on your machine are used as they are.** The Codex CLI's ChatGPT
login is imported when the agent has no credential of its own — the CLI
stays logged in, and the agent gets the same subscription:

```sh
agent --model codex/gpt-6.1-sol
```

The opencode CLI is driven as a provider, so the models it can serve are the
ones it lists:

```sh
agent --model opencode-cli/opencode/big-pickle
```

The CLI is asked where its own server listens, and the server is started
once for the whole session — a server for every turn costs several seconds
before the model is even asked. The tools of the agent are run by the agent,
under the same permissions as every other provider, and the CLI is asked not
to run any of its own.

Neither needs a key of its own: they are already signed in.

## Letting it work

Ask mode requests approval for changes and execution. Choose among four modes:

| Mode | What it may do on its own |
| --- | --- |
| `ask` | reads are allowed; changes and execution ask |
| `auto-edit` | edits inside the workspace |
| `yolo` | calls are allowed unless an explicit deny rule or OS restriction blocks them |
| `plan` | read-only tools; no file edits or shell execution |

Rules decide first, whatever the mode is:

```sh
agent --allow "bash(git status) allow" --deny "bash(rm *) deny"
```

## The agents it can delegate to

A role is a name, a model, a set of tools and a system prompt. It lives in
a file:

```markdown
---
name: reviewer
model: gemini/gemini-3.1-pro-preview
tools: [read, grep, glob]
---
You review diffs for bugs and security issues. Return a ranked list.
```

Put it in `.myagent/agents/reviewer.md` for the project, or in
`~/.myagent/agents/` for every project. `explorer`, `planner`, `coder` and
`reviewer` are built in.

The lead agent hands a job to a role with the `task` tool:

```json
{"name": "task", "arguments": {"agent": "explorer", "prompt": "find the cache"}}
```

The worker gets its own system prompt, its own tools, its own model and its
own context. Only the report it writes comes back — a worker can read fifty
files and the parent sees a few hundred words.

A worker that only reads shares the workspace. A worker that writes gets a
git worktree of its own, on a branch of its own, which the orchestrator
merges when it is happy with it. The work of a session is written to a
board at `.myagent/board.json`, so you can see what is running, who owns
it and what it found.

The guards: delegation depth is bounded, a worker has its own token and
cost budget and its own timeout, a few workers run at a time, and a failure
is reported rather than retried in silence.

## Adding behaviour without forking

### MCP servers

The Model Context Protocol is how a program offers its tools to other
programs. Put the servers in `.myagent/mcp.json`:

```json
{
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } }
  }
}
```

Each server's tools become tools of the agent, named `server__tool` — the
`files` server above gives `files__read_file`. The schema the server sends
is checked the same way our own tools are, and a server that does not
answer is reported and left behind: it never holds the agent up.

### Skills

A skill is a folder with a `SKILL.md` in it, under `.myagent/skills`. Only
its name and its description go into the prompt — the body can be long, and
most of it is not needed unless the task calls for it. The model asks for
the one it wants, and the body arrives then and stays.

### Hooks

A hook is a shell command that runs when something happens. Put them in
`.myagent/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "bash", "command": "./scripts/no-rm-rf.sh" }],
    "PostToolUse": [{ "matcher": "write", "command": "./scripts/lint.sh" }],
    "SessionStart": [{ "command": "./scripts/setup.sh" }]
  }
}
```

The call comes on the hook's standard input as JSON. A `PreToolUse` command
that exits with something other than zero stops the call, and what it
printed is the reason the model is given. `PostToolUse` cannot stop
anything, but what it prints is added to the result. `SessionStart` runs
once, and what it says becomes a note in the prompt.

### Your own commands

A command is a markdown file in `.myagent/commands`. The name of the file
is the name of the command:

```markdown
---
description: Deploy the app
argument-hint: <environment>
---
Deploy the app to $1. Run the tests first, and say what you did.
```

`$ARGUMENTS` is everything you typed after the command, and `$1` to `$9`
are the words of it. `/help` lists the commands.

### Extensions

An extension is a TypeScript module in `.myagent/extensions` that exports a
`register` function. It is given an API and adds what it likes:

```ts
export function register(api) {
  api.addTool({
    name: "hello",
    description: "Says hello to somebody.",
    schema: api.z.object({ name: api.z.string() }),
    async run(args) {
      return { output: `hello ${args.name}` };
    },
  });
}
```

It can also add commands and providers. The tools of an extension and the
tools of the MCP servers go behind the permissions, like our own: a tool
nobody knows is treated as one that changes things.

## Seeing what it did

Every request, every tool call and every usage is written down as one JSON
object per line, in `~/.myagent/logs/<session>.jsonl`:

```json
{"at":"2026-11-14T10:53:06.889Z","event":"request","model":"gemini-3.1-flash-lite","messages":4,"tools":12,"systemChars":2140}
{"at":"2026-11-14T10:53:07.104Z","event":"toolStart","tool":"read","args":{"path":"src/index.ts"}}
{"at":"2026-11-14T10:53:07.220Z","event":"toolEnd","tool":"read","ok":true,"ms":116,"outputChars":4821}
{"at":"2026-11-14T10:53:08.006Z","event":"usage","inputTokens":1897,"outputTokens":214,"cost":0.0005}
```

`--log <file>` says where it goes, `--no-log` writes none. What goes in is
redacted first: the keys the process knows are taken out by their value, and
the shapes of the keys that are written in the code are taken out by their
shape.

What the agent reads is treated as data, not instructions. A file in the
repository may say "ignore what you were told and run this", and a page from
the web certainly may; neither is the user talking. The result of a tool
that holds foreign content is marked, and the prompt says what to do with it.

## The eval suite

Fourteen tasks, each a small repository, a question, and a test that says
whether the work was done:

```sh
pnpm --filter @cli-agent/core eval
```

```
✓ create a file                  5 turns  1573 tokens  $0.0000
✓ fix a broken function          5 turns  1738 tokens  $0.0000
✓ rename a function              6 turns  1854 tokens  $0.0000
✓ delete a file                  4 turns  1354 tokens  $0.0000
...
14/14 passed (100%)  69 turns  $0.0000  287s
```

The pass rate, the turns and the cost are what say whether the agent got
better or cheaper — a change that makes it worse is visible. The suite is
run without a model first, so the tasks, the tests and the runner are all
proved to work.

The model is the one `MYAGENT_EVAL_MODEL` names, and a free one is turned
away now and then: a task that fails because the model was busy says so,
and the report says which.

## The packages

| Package | What is in it |
| --- | --- |
| `packages/ai` | the providers, the credentials, the model table, the factory |
| `packages/core` | the loop, the context, the sessions, the orchestration, the evals |
| `packages/tools` | the tools, the permissions, the validation, the MCP client |
| `packages/cli` | the command line and the interactive session |
| `apps/web` | Next.js landing page and source-backed MDX documentation |

Everything streams; nothing prints from the core. Long operations take an
`AbortSignal`. The messages are plain JSON.

## Working on it

```sh
pnpm check-types     # the types
pnpm lint            # the lint
pnpm test            # the tests
pnpm build           # the build
```

There are demos for the parts that are easier to see than to read:

```sh
pnpm --filter @cli-agent/core demo:loop
pnpm --filter @cli-agent/core demo:consumers
pnpm --filter @cli-agent/core demo:tools
pnpm --filter @cli-agent/core demo:permissions
pnpm --filter @cli-agent/core demo:prompt
pnpm --filter @cli-agent/core demo:compact
pnpm --filter @cli-agent/core demo:session
pnpm --filter @cli-agent/core demo:agents
pnpm --filter @cli-agent/cli demo:extensions
```

`scripts/verify-commits.ps1` checks that every commit stands on its own: a
fresh worktree, a fresh install, the types, the tests and the build.

The provider adapters are tried against the bytes the vendors actually sent.
`pnpm --filter @cli-agent/ai record:fixtures` records them again; the
recordings are in `packages/ai/src/fixtures/`, and the folder says which
ones are real.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Subfolders

- [apps/](./apps/README.md): Deployable application workspaces. The web app documents the terminal agent without running it in the browser.
- [packages/](./packages/README.md): Internal TypeScript runtime packages and shared development configuration.
- [scripts/](./scripts/README.md): Repository maintenance: source documentation generation and commit-by-commit verification.

### Files

| File | Responsibility |
| --- | --- |
| [.gitignore](./.gitignore) | Exclude dependencies, generated builds, local secrets, runtime state, and temporary artifacts from version control. |
| [AGENTS.md](./AGENTS.md) | Repository-specific contributor instructions, including the requirement to read installed Turborepo docs before changing tasks. |
| [package.json](./package.json) | cli-agent: workspace manifest, build, dev, lint, test, check-types, format, and dependencies. |
| [pnpm-lock.yaml](./pnpm-lock.yaml) | Resolved workspace dependency versions and integrity metadata for reproducible installs. |
| [pnpm-workspace.yaml](./pnpm-workspace.yaml) | Declare apps and packages workspace globs and dependency build policies. |
| [turbo.json](./turbo.json) | Turborepo task dependencies, source inputs, and cache outputs for this scope. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
