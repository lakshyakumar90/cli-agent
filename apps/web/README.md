# Agent web

The Next.js landing page and MDX guide for the terminal agent. Routes include `/`
and nineteen guides under `/docs`, including stack alternatives, infrastructure,
and performance decisions. No API key or backend service is needed.

The redesigned product demonstration uses Stageshow's Stage and terminal Window
with a separate compact composition. Attribution is in
`components/stageshow/NOTICE.md`; visual verification is in `components/REHEARSAL.md`.

## Local development

From the repository root:

```sh
pnpm install
pnpm --filter @cli-agent/web dev
```

Open http://localhost:3000. Build with `pnpm --filter @cli-agent/web build` and
serve production output with `pnpm --filter @cli-agent/web start`.

## Authoring

Write local MDX in `content/docs`, register the guide in `lib/docs.ts`, and use
the shared components in `mdx-components.tsx`. Diagrams live in `public/diagrams`
as actual `.mmd` files. `DESIGN.md` records the visual direction and references.

Regenerate the source index and folder guides after moving or adding files:

```sh
node scripts/document-repository.mjs --readmes
pnpm --filter @cli-agent/web test
pnpm --filter @cli-agent/web check-types
pnpm --filter @cli-agent/web build
pnpm --filter @cli-agent/web test:e2e
```

The browser suite starts a production server on port 3100. Install Chromium with
`pnpm --filter @cli-agent/web exec playwright install chromium` if necessary.
Playwright traces and screenshots belong in ignored `test-results/`.

Search is local, code highlighting runs on the server, and Mermaid is loaded on
demand with strict security. Only trusted, checked-in MDX is compiled. The site
does not execute its terminal examples or collect credentials.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Subfolders

- [app/](./app/README.md): App Router routes, root layout, metadata, and responsive global styles.
- [components/](./components/README.md): Reusable presentation and interaction components. Client-only behavior is limited to search, previews, clipboard controls, and diagram rendering.
- [content/](./content/README.md): Checked-in documentation content and the generated repository inventory.
- [lib/](./lib/README.md): Navigation contracts and server content helpers. Keep Node filesystem code out of client components.
- [public/](./public/README.md): Static assets served unchanged by Next.js.
- [scripts/](./scripts/README.md): Node test helpers for content integrity and repository documentation coverage.
- [tests/](./tests/README.md): Production-browser checks for navigation, search, clipboard, diagrams, and responsive overflow.

### Files

| File | Responsibility |
| --- | --- |
| [.gitignore](./.gitignore) | Keep Next.js output, TypeScript caches, and Playwright artifacts out of version control. |
| [DESIGN.md](./DESIGN.md) | Record the original visual direction, tokens, typography, research references, and accessibility requirements. |
| [mdx-components.tsx](./mdx-components.tsx) | Map MDX elements to highlighted code, responsive tables, callouts, diagrams, and the file guide. |
| [mdx.d.ts](./mdx.d.ts) | Declare local MDX modules as typed React components for the explicit guide import registry. |
| [next.config.mjs](./next.config.mjs) | Configure local MDX, GFM, heading slugs, supported page extensions, and Next.js headers. |
| [package.json](./package.json) | @cli-agent/web: workspace manifest, dev, build, start, check-types, test, test:e2e, docs:generate, and dependencies. |
| [playwright.config.ts](./playwright.config.ts) | Start a production test server and run desktop/mobile browser checks. |
| [tsconfig.json](./tsconfig.json) | Workspace TypeScript compiler settings and source inclusion. |
| [turbo.json](./turbo.json) | Turborepo task dependencies, source inputs, and cache outputs for this scope. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
