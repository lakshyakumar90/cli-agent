# packages/cli

Terminal command and runtime composition. Build with `pnpm --filter @cli-agent/cli build`; see `TERMINAL_UI.md` for renderer boundaries.

## Run and build

```sh
pnpm --filter @cli-agent/cli dev
pnpm --filter @cli-agent/cli build
pnpm --filter @cli-agent/cli start --help
pnpm --filter @cli-agent/cli test
```

`src/cli.ts` chooses interactive, print, JSON, or RPC output. `src/session.ts`
composes providers, tools, live permissions, journal, workers, and extensions.
`src/session-controller.ts` switches saved state consistently. The pi-tui UI lives
in `src/ui/`; see `TERMINAL_UI.md` for ownership boundaries and native checks.

## Local installation

For local OpenCode models, use `agent --model opencode-cli/opencode/beam-free`.
Run `opencode --version` in the same shell; the bridge is verified with 2.2.5.
`MYAGENT_OPENCODE_COMMAND` selects an absolute CLI path if npm/pnpm shims differ.

After building, run `npm pack` from this folder and install the resulting tarball
with `npm install -g ./cli-agent-cli-0.1.0.tgz`. Restart existing processes to load
changes. Bun is optional for `build:binary`, which compiles for the build platform.
The website installation guide lives in `apps/web/content/docs/installation.mdx`.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Subfolders

- [scripts/](./scripts/README.md): Extension demos, terminal driving helpers, and a no-network native terminal smoke fixture.
- [src/](./src/README.md): CLI entry point, arguments, provider catalog, session composition, review, and output consumers.

### Files

| File | Responsibility |
| --- | --- |
| [eslint.config.js](./eslint.config.js) | Workspace lint configuration using shared repository presets. |
| [package.json](./package.json) | @cli-agent/cli: workspace manifest, dev, build, build:binary, demo:extensions, start, lint, check-types, test, and dependencies. |
| [TERMINAL_UI.md](./TERMINAL_UI.md) | `InteractiveUi` is the only interactive input owner. Pi's `TuiMainScreen` owns output, cursor movement, synchronized frames, resizing, and native |
| [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) | The interactive terminal uses `@earendil-works/pi-tui` 1.5.2 from https://github.com/earendil-works/pi, licensed under the MIT License. |
| [tsconfig.json](./tsconfig.json) | Workspace TypeScript compiler settings and source inclusion. |
| [tsup.config.ts](./tsup.config.ts) | tsup.config.ts supports Terminal command and runtime composition. Build with `pnpm --filter @cli-agent/cli build`; see `TERMINAL_UI.md` for renderer boundaries.. |
| [vitest.config.ts](./vitest.config.ts) | Vitest configuration for deterministic workspace tests. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
