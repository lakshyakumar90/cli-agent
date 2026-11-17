# packages/cli/src

CLI entry point, arguments, provider catalog, session composition, review, and output consumers.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Subfolders

- [ui/](./ui/README.md): Interactive pi-tui renderer, display state, selectors, editor helpers, and screen regressions. Legacy helpers coexist with the current main-screen renderer.

### Files

| File | Responsibility |
| --- | --- |
| [agents.ts](./agents.ts) | Agents. An agent is a model, a prompt and a set of tools under a name. The main agent is the one you are talking to; the others are profiles you can switch to, and the ones a sub-agent can be given. |
| [args.test.ts](./args.test.ts) | Regression tests for parseArgs, parseRuleArgument, isPermissionMode. |
| [args.ts](./args.ts) | What the command line says. agent interactive agent -p "do the thing" print mode agent --json -p "..." the events as JSON lines agent --rpc JSON lines in, JSON lines out |
| [catalog.test.ts](./catalog.test.ts) | Regression tests for the catalogue, the default model. |
| [catalog.ts](./catalog.ts) | Discover available models from authenticated providers, local CLI bridges, and extensions, retaining provider failures. |
| [cli.ts](./cli.ts) | Executable entry point: parse arguments, compose a session, and select interactive, print, JSON, or RPC output. |
| [commands.test.ts](./commands.test.ts) | Regression tests for print mode, json mode, rpc mode. |
| [commands.ts](./commands.ts) | The modes. All four read the same event stream; they only differ in what they do with it. The answer goes to stdout, so `agent -p "..." > answer.txt` works and the tool activity stays on stderr where it does not pollute the answer. |
| [review.test.ts](./review.test.ts) | Regression tests for read-only code review. |
| [review.ts](./review.ts) | Capture a read-only Git diff, fingerprint it, validate structured findings, and run a review without editing tools. |
| [session-controller.test.ts](./session-controller.test.ts) | Regression tests for session switching. |
| [session-controller.ts](./session-controller.ts) | Switch saved sessions and persist model preferences, model-change markers, workers, and reviews atomically. |
| [session.test.ts](./session.test.ts) | Regression tests for the session. |
| [session.ts](./session.ts) | The session the CLI works in. A provider from the ref, the tools behind the permissions, and the state the loop keeps — with the conversation written down as it happens, so it can be picked up again later. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
