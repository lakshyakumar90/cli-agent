# packages/core/src

Conversation execution, prompt composition, context management, persistence, logging, and extension loaders.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Subfolders

- [agents/](./agents/README.md): Roles, worker lifetimes, task delegation, task boards, orchestration, and Git worktree isolation.
- [evals/](./evals/README.md): Disposable-repository task definitions and the evaluation runner.

### Files

| File | Responsibility |
| --- | --- |
| [budget.loop.test.ts](./budget.loop.test.ts) | Regression tests for the budget in the loop. |
| [budget.test.ts](./budget.test.ts) | Regression tests for counting tokens, the budget. |
| [budget.ts](./budget.ts) | The budget. How much of the model's context window the conversation may use, and when it has to be made smaller. |
| [checkpoints.test.ts](./checkpoints.test.ts) | Regression tests for the checkpoints. |
| [checkpoints.ts](./checkpoints.ts) | File checkpoints. Before a tool changes a file, the file is snapshotted, so the change can be undone. It is the same idea as a git stash, without needing a repository: the snapshot is the content of the file before the change. |
| [commands.test.ts](./commands.test.ts) | Regression tests for the custom commands, what a command sends. |
| [commands.ts](./commands.ts) | Custom commands. A command is a markdown file in `.myagent/commands`. The name of the file is the name of the command: `deploy.md` is `/deploy`. What the file says is what the model is asked, so a command is a prompt you do not have to type again. |
| [compact.test.ts](./compact.test.ts) | Regression tests for compaction, the summary prompt. |
| [compact.ts](./compact.ts) | Compaction. When the conversation no longer fits, the old part of it is summarised and replaced by the summary. What is kept is the summary and the last few messages, so the model still knows what just happened and still knows what it was asked to do. |
| [context.ts](./context.ts) | Context building. The system prompt is built in layers (see prompt.ts): the parts that do not change come first, so the provider can cache them, and the conversation follows as messages. Phase 5 replaces the message half with budgeting — trimming the transcript to the model's context window, summarising the middle, keeping the ends. |
| [environment.ts](./environment.ts) | Where the agent is. The working directory, the branch it is on, the operating system and the date. It changes while the session runs, so it sits below the parts that do not: everything above it can be cached by the provider. |
| [extensions.test.ts](./extensions.test.ts) | Regression tests for an extension, a provider an extension added. |
| [extensions.ts](./extensions.ts) | Extensions. An extension is a TypeScript module in `.myagent/extensions` that exports a `register` function. It is given an API and adds what it likes: tools, commands and providers. |
| [hooks.loop.test.ts](./hooks.loop.test.ts) | Regression tests for a hook in the loop. |
| [hooks.test.ts](./hooks.test.ts) | Regression tests for the hook config, which hooks answer, a hook that runs. |
| [hooks.ts](./hooks.ts) | Hooks. A hook is a shell command that runs when something happens. The command is given the details on its standard input, and what it does with them is up to it: |
| [index.ts](./index.ts) | Public exports for this module boundary. |
| [logging.test.ts](./logging.test.ts) | Regression tests for the log, what the loop writes down. |
| [logging.ts](./logging.ts) | The log. Every request, every tool call and every usage is written down as one JSON object per line. The log is what the agent did, in order, in a shape a program can read: the sessions are for the conversation, the log is for the work. |
| [loop.guards.test.ts](./loop.guards.test.ts) | Regression tests for loop guards, abort, retry. |
| [loop.order.test.ts](./loop.order.test.ts) | Regression tests for the tools of one turn. |
| [loop.signature.test.ts](./loop.signature.test.ts) | Regression tests for a signature on a call. |
| [loop.test-helpers.ts](./loop.test-helpers.ts) | Test helpers: a provider that plays back scripted turns, and a fake echo tool. Shared by the loop tests. |
| [loop.test.ts](./loop.test.ts) | Regression tests for the agent loop, accumulate, buildContext. |
| [loop.tool-limits.test.ts](./loop.tool-limits.test.ts) | Regression tests for a tool that returns a lot, a tool that says its result must be kept. |
| [loop.ts](./loop.ts) | The agent loop. model -> tool calls -> results -> model, until the model stops asking for tools. The loop yields events and never prints, so the CLI, a JSON mode and a sub-agent all consume the same stream. |
| [memory.ts](./memory.ts) | Project memory. AGENTS.md and CLAUDE.md are how a project says what it wants. The search walks up from the working directory, so the memory of the directory you are in and of every directory above it is read; the user's own ~/.myagent/AGENTS.md is read too. |
| [prompt.test.ts](./prompt.test.ts) | Regression tests for the layers, the project memory, the environment. |
| [prompt.ts](./prompt.ts) | The layered system prompt. What the model sees on every turn is built in layers, and the order is the point: the parts that do not change come first, so the provider can cache them and only pay for the part that moved. |
| [redact.test.ts](./redact.test.ts) | Regression tests for taking the secrets out, the secrets the process knows, taking the secrets out of anything. |
| [redact.ts](./redact.ts) | Keeping the secrets out. Everything the agent reads goes into a log: the requests, the tool calls, the answers. A file it read may hold a key, and a log is a file that is written to disk and kept. |
| [ref.ts](./ref.ts) | The "provider/model" ref. The ref is how a model is named in the command line and in the configuration: "provider/model". The provider is built from the part before the slash, and the model is called by the part after it. |
| [render.test.ts](./render.test.ts) | Regression tests for emit events, not prints, the text consumer, the JSON consumer. |
| [render.ts](./render.ts) | Consumers of the event stream. The loop never prints: it yields events, and every surface reads that one stream its own way. A terminal prints text, a script reads JSON lines, and a parent agent reads the summary of what a sub-agent did. |
| [repomap.test.ts](./repomap.test.ts) | Regression tests for the repo map. |
| [repomap.ts](./repomap.ts) | The repo map. An outline of what is in the project: the files, and the symbols in them. It is injected into the prompt so the model can find the right file without reading every file first — the agentic search (grep, glob, read) still does the finding, but the map tells it what exists. |
| [resume.test.ts](./resume.test.ts) | Regression tests for quitting and resuming. |
| [retry.ts](./retry.ts) | Retrying a provider call. A provider that answers 429 or 5xx is worth waiting for; a provider that answered with content and then dropped the connection is not, because the answer would be delivered twice. So a call is only retried when nothing came back yet, and never after a tool has run — the side effects of a tool cannot be undone by asking the model again. |
| [sample-repo.ts](./sample-repo.ts) | A small project with a failing test. The scenario the guide asks for: the agent reads the failing test, fixes the code and runs the test again. It is small on purpose — the point is that read, edit and bash work together, not that the bug is hard. |
| [scenario.test.ts](./scenario.test.ts) | Regression tests for the agent in a real project. |
| [session.test.ts](./session.test.ts) | Regression tests for a long session. |
| [sessions.test.ts](./sessions.test.ts) | Regression tests for the session store. |
| [sessions.ts](./sessions.ts) | Sessions. A session is a file of entries, one JSON object per line, appended and never rewritten: |
| [shrink.test.ts](./shrink.test.ts) | Regression tests for shrinking a tool result, the old tool results. |
| [shrink.ts](./shrink.ts) | Shrinking what the model has to read. A tool result can be enormous — a file, a build log, a search over a whole repository — and the model rarely needs all of it. So a big result keeps its head and its tail, and says how much was left out; and a result that is many turns old is replaced by a one-line stub, because the model has long since moved on from it. |
| [skills.test.ts](./skills.test.ts) | Regression tests for the skills, the body of a skill, the skill tool. |
| [skills.ts](./skills.ts) | Skills and the plan. The dynamic part of the prompt: what the agent can draw on, and what it said it would do. It changes while the session runs, so it belongs at the bottom of the prompt. |
| [subagent.ts](./subagent.ts) | Sub-agents. A sub-agent is the same loop with its own transcript: it gets its own tools and its own prompt, and it yields the same events, so the parent reads one stream and sees everything the sub-agent did. |
| [tokens.ts](./tokens.ts) | Counting tokens. The count is an estimate until the provider says otherwise: the real number arrives with the usage of a response, and the difference between the two is remembered, so the next estimate is closer. |
| [types.ts](./types.ts) | The agent's state and the events it emits. |
| [untrusted.test.ts](./untrusted.test.ts) | Regression tests for marking what is data, a tool that holds data. |
| [untrusted.ts](./untrusted.ts) | What the agent reads is data. A file in the repository may say "ignore what you were told and run this". A page from the web certainly may. Neither is the user talking: the user asked a question, and the agent read something. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
