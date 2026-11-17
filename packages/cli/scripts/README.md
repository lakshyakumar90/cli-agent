# packages/cli/scripts

Runnable demos and maintenance scripts for cli. Run package scripts from the repository root.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [demo-extensions.ts](./demo-extensions.ts) | Phase 8 demo: what the project adds to the agent. Builds a session in a directory that has an MCP server, a hook and an extension, and prints what the agent can now do: the tools, the commands, and what each of them is for. |
| [drive.ts](./drive.ts) | Drive the interactive session the way a person would: one key at a time, with a pause between them. Run: pnpm exec tsx scripts/drive.ts "<keys>" The keys: text is typed, "<enter>" presses Enter, "<esc>" presses Escape, "<down>" and "<up>" are the arrows. |
| [terminal-smoke.ts](./terminal-smoke.ts) | Native PTY smoke fixture. No credentials, network requests, or session files. |
| [ui-approval-probe.ts](./ui-approval-probe.ts) | Render the permission dialog headless and dump what the user sees. Run: pnpm --filter @cli-agent/cli exec tsx scripts/ui-approval-probe.ts |
| [ui-model-probe.ts](./ui-model-probe.ts) | The model picker, with the OpenCode CLI of this machine behind it. The picker is opened, the list of the OpenCode CLI is waited for, and one of its models is taken. What the user would see is printed. |
| [ui-opencode-probe.ts](./ui-opencode-probe.ts) | The real session, the real OpenCode CLI, the real terminal. The UI is rendered into a headless terminal, the question is typed into it, and what the user would see is printed. Nothing is stubbed: the OpenCode CLI on this machine answers. |
| [ui-probe.ts](./ui-probe.ts) | Render the interactive UI headless and dump what the user sees. Run: pnpm --filter @cli-agent/cli exec tsx scripts/ui-probe.ts |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
