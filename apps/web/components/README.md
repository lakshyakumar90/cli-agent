# apps/web/components

Reusable presentation and interaction components. Client-only behavior is limited to search, previews, clipboard controls, and diagram rendering.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Subfolders

- [stageshow/](./stageshow/README.md): Local source and file guide.

### Files

| File | Responsibility |
| --- | --- |
| [brand.tsx](./brand.tsx) | Reusable original Agent wordmark and terminal-prompt SVG. |
| [code-block.tsx](./code-block.tsx) | Server-side Shiki highlighting, code copying, and Mermaid fence detection. |
| [copy-button.tsx](./copy-button.tsx) | Clipboard button with explicit copied and failure feedback. |
| [diagram.tsx](./diagram.tsx) | Read an allowed local .mmd asset on the server and expose rendered/source/download views. |
| [file-reference.tsx](./file-reference.tsx) | Search and group the checked-in source inventory with repository links. |
| [header.tsx](./header.tsx) | Shared site navigation, source link, and server-populated documentation search. |
| [mermaid.tsx](./mermaid.tsx) | Lazy, strictly secured Mermaid rendering with serialized work, captions, source, and fallback. |
| [provider-switcher.tsx](./provider-switcher.tsx) | Provider connectivity tabs with requirements and copyable command examples. |
| [REHEARSAL.md](./REHEARSAL.md) | Gold: Stageshow 1.1.1 `static-card`. Kept the masked composition and one dominant product surface; changed the subject to the actual Agent terminal workflow and used the kit's terminal Window. The reference was bundled and captured locally before the final visual pass. States: Explore, Build, Review |
| [search.tsx](./search.tsx) | Keyboard-accessible full-text guide search in a native modal dialog. |
| [terminal-preview.tsx](./terminal-preview.tsx) | Illustrative Explore, Build, and Review session tabs; no commands execute in the browser. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
