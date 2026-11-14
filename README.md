# A coding agent, built from scratch

A coding agent that runs in the terminal: it reads a codebase, changes it,
runs the tests and explains what it did. It streams everything, keeps a
history you can go back to, and can hand parts of the job to other agents
that work on their own.

```
agent -p "find every place that writes to the database and list them"
```

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

## Install and run

```sh
pnpm install
pnpm build
pnpm --filter @cli-agent/cli start          # interactive
pnpm --filter @cli-agent/cli start -p "..." # print the answer and exit
```

Requires Node 24 or newer.

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
  -v, --verbose                 show the tool activity
  -h, --help                    this text
```

In the interactive session:

| Key | What it does |
| --- | --- |
| `/model` | pick another model |
| `/login` | sign in to a provider |
| `/compact` | summarise the conversation now |
| `/clear` | start the conversation over |
| `/resume` | open another session |
| `/fork` | branch the conversation from an earlier message |
| `/tree` | show the branches of the session |
| `/undo` | take back the last change |
| `/agents` | the agents it can delegate to |
| `@file` | put a file into the prompt |
| `!command` | run a shell command |
| `Esc` | stop the turn |
| `Shift+Tab` | cycle the permission mode |

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

## Letting it work

The agent asks before it changes anything. Four modes:

| Mode | What it may do on its own |
| --- | --- |
| `ask` | nothing; every change is confirmed |
| `auto-edit` | edits inside the workspace |
| `yolo` | everything |
| `plan` | nothing; it only reads and writes the plan |

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

The guards: a worker cannot spawn workers, a worker has its own token and
cost budget and its own timeout, a few workers run at a time, and a failure
is reported rather than retried in silence.

## The packages

| Package | What is in it |
| --- | --- |
| `packages/ai` | the providers, the credentials, the model table, the factory |
| `packages/core` | the loop, the context, the sessions, the orchestration |
| `packages/tools` | the tools, the permissions, the validation |
| `packages/cli` | the command line and the interactive session |

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
```

`scripts/verify-commits.ps1` checks that every commit stands on its own: a
fresh worktree, a fresh install, the types, the tests and the build.
