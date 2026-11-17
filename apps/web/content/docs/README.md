# apps/web/content/docs

MDX usage guides and implementation walkthroughs. Register new guides in `lib/docs.ts`.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [agent-loop.mdx](./agent-loop.mdx) | The main loop is an async generator in packages/core/src/loop.ts. Interactive UI, print output, JSON, RPC, and subagents consume the same stream. |
| [architecture.mdx](./architecture.mdx) | The runtime is a TypeScript monorepo with four functional packages. A separate Next.js application provides this landing page and guide. The core never prints; consumers choose how to render its async event stream. |
| [commands.mdx](./commands.mdx) | Use agent --help for the installed build's flags and /help for interactive commands, including discovered project commands. |
| [contributing.mdx](./contributing.mdx) | Work from the repository root with the pnpm version declared in package.json. Preserve existing changes and keep implementation updates close to their tests and documentation. |
| [decisions.mdx](./decisions.mdx) | These are the tradeoffs visible in the current implementation, with conditions for changing them. They explain the present design; they are not reconstructed historical meeting notes. An alternative can be the better choice for a different workload. |
| [extensions.mdx](./extensions.mdx) | Configure project-specific behavior in .myagent/. Each extension form joins the same tool and permission pipeline. |
| [infrastructure.mdx](./infrastructure.mdx) | Agent currently runs on the developer's machine. The documentation app is a separate Next.js process with statically generated guide routes. There is no required hosted application server, database, queue, or account system for using the CLI or reading these guides. |
| [installation.mdx](./installation.mdx) | Build the CLI from the repository, then install its local tarball. These steps do not assume the package has been published to npm. |
| [introduction.mdx](./introduction.mdx) | Agent is a coding assistant that runs in your terminal. It reads files, applies changes through tools, runs approved commands, and keeps a conversation you can return to. You choose the model provider and level of access. |
| [performance.mdx](./performance.mdx) | Performance has several independent meanings here: time to the first model response, responsiveness while tools run, prompt size and cost, startup time, website loading, and documentation build time. Improving one does not prove the others improved. |
| [permissions.mdx](./permissions.mdx) | Permissions are evaluated when a tool executes. The parent, workers, extension tools, and MCP tools use the same policy wrapper. |
| [providers.mdx](./providers.mdx) | The loop speaks one internal event format. Adapters translate vendor streams into text, supplied thinking, tool calls, and completion usage. |
| [quickstart.mdx](./quickstart.mdx) | Start with a small task and a read-only session. Inspect the model, tool activity, and permission behavior before permitting edits. |
| [repository.mdx](./repository.mdx) | The repository separates model I/O, tool execution, runtime orchestration, terminal presentation, and this website. The index below describes maintained source and configuration files; generated output, dependency trees, local credentials, and Git internals are excluded. |
| [sessions.mdx](./sessions.mdx) | Sessions preserve the conversation as it happens. The journal is separate from terminal display state, so opening a picker or detail view does not add a model message. |
| [terminal-ui.mdx](./terminal-ui.mdx) | The interactive terminal uses pi-tui's differential renderer. One owner reads input; the UI updates the screen rather than appending a new permission line or thinking label for every state change. |
| [troubleshooting.mdx](./troubleshooting.mdx) | Start with the visible error, selected provider, and installed version. Distinguish an upstream account failure from a local tool or UI problem. |
| [web.mdx](./web.mdx) | This website is a separate Next.js App Router workspace at apps/web. It serves the landing page at / and a statically generated MDX guide at /docs and /docs/<slug>. |
| [workers.mdx](./workers.mdx) | Workers receive a bounded task with separate context. Read-only workers can share the workspace. Writing workers can use isolated Git worktrees; their changes still need inspection and merge handling. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
