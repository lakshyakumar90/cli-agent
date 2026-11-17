# apps/web/lib

Navigation contracts and server content helpers. Keep Node filesystem code out of client components.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [content.ts](./content.ts) | Server-only MDX reading, full-text search corpus, and heading extraction. |
| [docs.ts](./docs.ts) | Explicit MDX import registry with guide slugs, descriptions, groups, and titles. |
| [links.ts](./links.ts) | Browser-safe documentation URL and repository URL helpers. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
