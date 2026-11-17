# packages

Internal TypeScript runtime packages and shared development configuration.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Subfolders

- [ai/](./ai/README.md): Provider-neutral messages, model metadata, authentication, stream adapters, and fixtures. Run `pnpm --filter @cli-agent/ai test`.
- [cli/](./cli/README.md): Terminal command and runtime composition. Build with `pnpm --filter @cli-agent/cli build`; see `TERMINAL_UI.md` for renderer boundaries.
- [core/](./core/README.md): Agent runtime: execution loop, context budgets, journals, workers, and extension discovery. Run `pnpm --filter @cli-agent/core test`.
- [eslint-config/](./eslint-config/README.md): Local source and file guide.
- [tools/](./tools/README.md): Local capabilities, schema validation, MCP connectivity, and permission enforcement. Run `pnpm --filter @cli-agent/tools test`.
- [typescript-config/](./typescript-config/README.md): Shared TypeScript compiler presets for Node, Next.js, and React library workspaces.

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
