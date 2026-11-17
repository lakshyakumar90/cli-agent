# packages/core/scripts

Runnable demos and maintenance scripts for core. Run package scripts from the repository root.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [demo-agents.ts](./demo-agents.ts) | Phase 7 demo: the lead delegates to the workers. One prompt, a real model, a real worker: the lead is asked to find out what is in a directory, it hands the job to the explorer, and only the explorer's report comes back — not the files it read. |
| [demo-compact.ts](./demo-compact.ts) | Phase 5 demo: a long session that has to compact. A conversation that has grown past the model's window is summarised, and the agent carries on with the summary. The point is that it still knows what the task was. |
| [demo-consumers.ts](./demo-consumers.ts) | Phase 2 demo: one event stream, three consumers. The loop yields events and prints nothing. A terminal reads them as text, a script reads them as JSON lines, and a parent agent reads the summary of a sub-agent — all from the same stream. |
| [demo-loop.ts](./demo-loop.ts) | Phase 2 demo: the loop with a real model and a fake echo tool. The model is asked to call the tool; the loop runs it, sends the result back, and the model answers. Everything printed here comes out of the loop's event stream — the loop itself never prints. |
| [demo-permissions.ts](./demo-permissions.ts) | Phase 3 demo: the agent, the tools and the permissions. A small project with a failing test. The agent reads the test, fixes the code and runs the test again — with the permission layer in front of the tools, in "ask" mode: the commands are allowed by a rule, and anything else would be put to the user. |
| [demo-prompt.ts](./demo-prompt.ts) | Phase 5 demo: the layered system prompt. Shows what the model is told on every turn, layer by layer, and which of the layers the provider can cache. |
| [demo-session.ts](./demo-session.ts) | Phase 6 demo: quit in the middle, come back, carry on. The first session asks for a tool and is then closed. The second session opens the same file, reads the conversation back and continues it — the model sees what happened before it was interrupted. |
| [demo-tools.ts](./demo-tools.ts) | Phase 3 demo: a real model with real tools. The model is given a small project and asked to fix it. It reads the file, edits it, and checks its work — through the same loop, the same tools and the same event stream as everything else. |
| [eval.ts](./eval.ts) | The eval suite, run against a real model. Each task is a small repository, a question, and a test. The report says how many passed, how many turns it took and what it cost. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
