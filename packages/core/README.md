# packages/core

Agent runtime: execution loop, context budgets, journals, workers, and extension discovery. Run `pnpm --filter @cli-agent/core test`.

## Role in the runtime

The async-generator loop owns messages, limits, context assembly, tool scheduling,
and journaling. It depends on `@cli-agent/ai` and `@cli-agent/tools` and never
prints. Interactive, print, JSON, RPC, and worker consumers can observe the same
event format. The `agents/` modules keep worker lifetimes separate from the UI.

## Work on this package

```sh
pnpm --filter @cli-agent/core test
pnpm --filter @cli-agent/core check-types
```

Start with `src/types.ts` and `src/loop.ts`. Demos under `scripts/` explain prompt,
context, permissions, compaction, sessions, and orchestration. `evals/` exercises
bounded tasks in disposable repositories; live runs depend on model access.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Subfolders

- [scripts/](./scripts/README.md): Runnable agent-loop demos, permission/session/worker examples, and evaluation entry points.
- [src/](./src/README.md): Conversation execution, prompt composition, context management, persistence, logging, and extension loaders.

### Files

| File | Responsibility |
| --- | --- |
| [eslint.config.js](./eslint.config.js) | Workspace lint configuration using shared repository presets. |
| [eval-report.json](./eval-report.json) | Shared eval report configuration preset. |
| [package.json](./package.json) | @cli-agent/core: workspace manifest, dev, demo:loop, demo:consumers, demo:tools, demo:permissions, demo:prompt, demo:compact, demo:session, demo:agents, eval, lint, check-types, test, and dependencies. |
| [tsconfig.json](./tsconfig.json) | Workspace TypeScript compiler settings and source inclusion. |
| [vitest.config.ts](./vitest.config.ts) | Vitest configuration for deterministic workspace tests. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
