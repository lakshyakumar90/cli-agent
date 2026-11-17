# packages/cli/src/ui

Interactive pi-tui renderer, display state, selectors, editor helpers, and screen regressions. Legacy helpers coexist with the current main-screen renderer.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [colors.ts](./colors.ts) | Colors. Plain ANSI: no dependency, works everywhere a terminal does, and can be switched off (NO_COLOR, or a terminal that does not want them). |
| [complete.test.ts](./complete.test.ts) | Regression tests for completing a path, completing a file. |
| [complete.ts](./complete.ts) | @-completion. Typing "@src/li" offers the files that start with it, so a file can be named without typing the whole path. |
| [components.ts](./components.ts) | Render the transcript, thinking previews, searchable selectors, and scrollable detail views. |
| [diff.ts](./diff.ts) | Diffs, for the edits. When the model edits a file, the interesting part is what changed: the lines that go and the lines that come. |
| [frame.test.ts](./frame.test.ts) | Regression tests for the box, the header, the welcome. |
| [frame.ts](./frame.ts) | The frame of the session. The header says where the agent is. The welcome says what it can do. The field is where the answer goes, and the line under it says what is left. |
| [helpers.ts](./helpers.ts) | Defines knownModels, modelIdOf, summarise for ui consumers. |
| [input.test.ts](./input.test.ts) | Regression tests for slash commands, the shell escape, @-completion. |
| [interactive.test.ts](./interactive.test.ts) | Regression tests for the interactive session. |
| [interactive.ts](./interactive.ts) | Compose the pi-tui screen, focused dialogs, prompt queue, permissions, model selection, sessions, and worker controls. |
| [markdown.ts](./markdown.ts) | Markdown, for the terminal. A small renderer: headings, bold, italic, inline code, fenced code, lists and paragraphs. It is not CommonMark, but it is the part of it that a model's answer actually uses. |
| [picker.test.ts](./picker.test.ts) | Regression tests for the model picker. |
| [picker.ts](./picker.ts) | A list you can pick from. It is drawn under the prompt, and the keys that are not the picker's go to the line as usual: the list is a list, not a mode. The arrows move, Enter takes, Escape puts it away. |
| [screen.test.ts](./screen.test.ts) | Regression tests for rendered terminal. |
| [slash.ts](./slash.ts) | Slash commands, and the shell escape. A line that starts with "/" is a command for the agent, not a message for the model. A line that starts with "!" is a shell command. |
| [status.ts](./status.ts) | The tool blocks. A tool call is a line: what it was asked to do, and whether it worked. The line folds, so a long output does not fill the screen. |
| [store.test.ts](./store.test.ts) | Regression tests for transcript state. |
| [store.ts](./store.ts) | Accumulate display-only transcript blocks and update thinking and tool status in place by identity. |
| [terminal.ts](./terminal.ts) | Adapt native or injected input/output streams to the pi-tui terminal interface. |
| [ui.test.ts](./ui.test.ts) | Regression tests for colors, markdown, the streaming markdown. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
