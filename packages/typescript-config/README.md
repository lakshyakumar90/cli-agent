# packages/typescript-config

Shared TypeScript compiler presets for Node, Next.js, and React library workspaces.

## Presets

- `base.json`: shared strict compiler defaults.
- `node.json`: Node/ESM package configuration.
- `nextjs.json`: App Router-compatible module resolution and Next plugin.
- `react-library.json`: reusable React library compilation settings.

Consumers choose an appropriate preset and keep local include/exclude paths in
their own tsconfig. `apps/web` currently declares its app-specific settings locally.
Changing a shared preset can affect several workspaces; run their type checks.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [base.json](./base.json) | Shared base configuration preset. |
| [nextjs.json](./nextjs.json) | Shared nextjs configuration preset. |
| [node.json](./node.json) | Shared node configuration preset. |
| [package.json](./package.json) | @repo/typescript-config: workspace manifest, package exports, and dependencies. |
| [react-library.json](./react-library.json) | Shared react library configuration preset. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
