# packages/core/src/agents

Roles, worker lifetimes, task delegation, task boards, orchestration, and Git worktree isolation.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [board.test.ts](./board.test.ts) | Regression tests for the board. |
| [board.ts](./board.ts) | The shared board. The workers of one task write to it, so the lead can see what is going on: which task, who owns it, what state it is in and what it found. It is a JSON file, so it survives a crash and can be read while the work is going on. |
| [isolation.test.ts](./isolation.test.ts) | Regression tests for the isolation. |
| [isolation.ts](./isolation.ts) | Isolation. A worker that only reads can share the workspace: it cannot change anything, so there is nothing to keep apart. A worker that writes gets a git worktree of its own, on a branch of its own, and the orchestrator merges the branch when it is happy with it. |
| [multi-agent.test.ts](./multi-agent.test.ts) | Regression tests for one prompt, many agents. |
| [orchestrator.test.ts](./orchestrator.test.ts) | Regression tests for the orchestrator, the pipeline, the generator and the critic. |
| [orchestrator.ts](./orchestrator.ts) | Orchestration. Three patterns, all over the same worker: |
| [roles.test.ts](./roles.test.ts) | Regression tests for an agent role, the roles. |
| [roles.ts](./roles.ts) | Agent roles. A role is a name, a model, a set of tools and a system prompt. It lives in a file: |
| [task-tool.test.ts](./task-tool.test.ts) | Regression tests for the task tool. |
| [task-tool.ts](./task-tool.ts) | The task tool. The parent delegates to a worker: the worker gets its own system prompt, its own tools and its own model, and only the report it writes comes back. A worker can read fifty files; the parent sees three hundred words. |
| [worker-manager.test.ts](./worker-manager.test.ts) | Regression tests for live workers. |
| [worker-manager.ts](./worker-manager.ts) | Own worker lifetimes, concurrency, cancellation, follow-ups, transcripts, and observable status. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
