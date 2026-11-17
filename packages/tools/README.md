# packages/tools

Local capabilities, schema validation, MCP connectivity, and permission enforcement. Run `pnpm --filter @cli-agent/tools test`.

## Role in the runtime

Tools declare schemas and effects; the host validates arguments before execution.
Local capabilities cover files, search, shell, and checklists. MCP transports turn
external tool specifications into the same interface. `src/permissions/` supplies
the pure policy decision, live controller, and enforcement wrappers used by both
parent and worker tools. Application permission policy is not an OS sandbox.

## Work on this package

```sh
pnpm --filter @cli-agent/tools test
pnpm --filter @cli-agent/tools check-types
```

Start at `src/types.ts`, `src/tools.ts`, and `src/permissions/controller.ts`.
Check path boundaries, cancellation, validation, and policy behavior when adding
a capability. MCP integration tests use subprocess and HTTP fixtures.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Subfolders

- [src/](./src/README.md): Read/write/edit/shell/search/checklist tools, execution helpers, path handling, validation, and MCP integration.

### Files

| File | Responsibility |
| --- | --- |
| [eslint.config.js](./eslint.config.js) | Workspace lint configuration using shared repository presets. |
| [package.json](./package.json) | @cli-agent/tools: workspace manifest, dev, lint, check-types, test, and dependencies. |
| [tsconfig.json](./tsconfig.json) | Workspace TypeScript compiler settings and source inclusion. |
| [vitest.config.ts](./vitest.config.ts) | Vitest configuration for deterministic workspace tests. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
