# apps/web/app

App Router routes, root layout, metadata, and responsive global styles.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Subfolders

- [docs/](./docs/README.md): Documentation route tree. Guides are compiled from local MDX content.

### Files

| File | Responsibility |
| --- | --- |
| [globals.css](./globals.css) | Shared color and typography tokens, landing/docs styles, responsive layouts, focus states, and reduced-motion rules. |
| [icon.svg](./icon.svg) | Original terminal-prompt favicon. |
| [layout.tsx](./layout.tsx) | Root HTML shell, metadata, self-hosted fonts, shared header, and global stylesheet. |
| [not-found.tsx](./not-found.tsx) | Recoverable 404 page with links to documentation and home. |
| [page.tsx](./page.tsx) | Landing page: interactive terminal workflows, features, providers, source installation, and FAQ. |
| [redesign.css](./redesign.css) | redesign.css supports App Router routes, root layout, metadata, and responsive global styles.. |
| [robots.ts](./robots.ts) | Public crawler rules for the documentation website. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
