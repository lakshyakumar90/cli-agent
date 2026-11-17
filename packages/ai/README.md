# packages/ai

Provider-neutral messages, model metadata, authentication, stream adapters, and fixtures. Run `pnpm --filter @cli-agent/ai test`.

## Role in the runtime

This package owns the shared message, usage, tool-schema, and provider-event
contracts. `factory.ts` resolves a provider; `providers/` translates wire formats;
`auth/` owns credentials and refresh. Neither provider adapters nor the registry
render terminal output. Preserve tool-call IDs and vendor signatures on replay.

## Work on this package

The OpenCode provider uses the installed local CLI, verified with 2.2.5. It
preserves the built-in profile and registers a fresh guarded agent through a
temporary local plugin. Native execution is blocked; host tools retain the
outer runtime's permissions. No direct OpenCode inference API fallback occurs.
`MYAGENT_OPENCODE_COMMAND` can select an explicit executable when multiple CLI
installations exist. The guard must register successfully for a turn to run.

```sh
pnpm --filter @cli-agent/ai test
pnpm --filter @cli-agent/ai check-types
```

Public exports are in `src/index.ts`. Protocol fixtures and mock servers make
normal tests deterministic. `record:fixtures` and `smoke:live` require live
provider access; inspect their configuration before running them.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Subfolders

- [scripts/](./scripts/README.md): Provider streaming demos, live smoke tests, and fixture recording. Live scripts need provider access and may incur costs.
- [src/](./src/README.md): Provider contracts, model registry, factory, streaming helpers, and normalized event handling.

### Files

| File | Responsibility |
| --- | --- |
| [eslint.config.js](./eslint.config.js) | Workspace lint configuration using shared repository presets. |
| [package.json](./package.json) | @cli-agent/ai: workspace manifest, dev, demo:stream, record:fixtures, smoke:live, lint, check-types, test, and dependencies. |
| [tsconfig.json](./tsconfig.json) | Workspace TypeScript compiler settings and source inclusion. |
| [vitest.config.ts](./vitest.config.ts) | Vitest configuration for deterministic workspace tests. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
