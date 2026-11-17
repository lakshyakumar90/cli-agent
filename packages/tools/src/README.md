# packages/tools/src

Read/write/edit/shell/search/checklist tools, execution helpers, path handling, validation, and MCP integration.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Subfolders

- [fixtures/](./fixtures/README.md): Small subprocess fixtures used by MCP integration tests.
- [permissions/](./permissions/README.md): Pure permission decisions plus a shared live controller, rule matching, and execution wrappers.

### Files

| File | Responsibility |
| --- | --- |
| [bash.ts](./bash.ts) | bash — run a command. The output is capped so a runaway command cannot fill the model's context: the head and the tail are kept and the middle is replaced by a note about how much was left out. |
| [edit.ts](./edit.ts) | edit — replace an exact string in a file. The most reliable edit format there is: the model says what is in the file and what should be there instead. The edit only goes through when what it says is actually there, and only once — a match that is missing or that appears more than once is an error, not a guess. |
| [exec.ts](./exec.ts) | Finding programs on PATH. |
| [files.test.ts](./files.test.ts) | Regression tests for read, write, edit. |
| [glob.ts](./glob.ts) | glob — find the files whose names match a pattern. ripgrep lists the files when it is installed; otherwise the same list is built here, skipping what git ignores. |
| [grep.ts](./grep.ts) | grep — search the files for a pattern. ripgrep does the work when it is installed: it is fast, it skips what git ignores, and its output is exactly the shape we want. When it is not installed, the same search runs here instead, with the same rules about ignored files. |
| [ignore.ts](./ignore.ts) | .gitignore rules. The search tools skip what git ignores, so a search does not wander into node_modules or a build directory. This is a practical subset of the format: patterns, directory patterns, anchoring and negation. |
| [index.ts](./index.ts) | Public exports for this module boundary. |
| [mcp.http.test.ts](./mcp.http.test.ts) | Regression tests for an MCP server over HTTP. |
| [mcp.server.test.ts](./mcp.server.test.ts) | Regression tests for a real MCP server. |
| [mcp.test.ts](./mcp.test.ts) | Regression tests for the MCP config, an MCP tool, the schema of an MCP tool. |
| [mcp.ts](./mcp.ts) | The MCP client. The Model Context Protocol is how a program offers its tools to other programs. A server is a process (or a URL) that says "here are my tools", and the agent calls them like its own. |
| [paths.ts](./paths.ts) | Paths, as the tools see them. Every tool takes a path the way a person would write it: relative to the working directory, or absolute. The resolved path is what the tool touches, and it is what the error messages name. |
| [read.ts](./read.ts) | read — a file, with line numbers. The output looks like `cat -n`: every line is prefixed with its number, so the model can say "line 42" and mean it. |
| [run.ts](./run.ts) | Running a program and collecting what it says. |
| [todo.ts](./todo.ts) | todo — the checklist the model keeps. The model rewrites the list when its plan changes, and reads it back when it needs to remember what is left. The list lives with the tool, so it lasts for the session. |
| [tools.test.ts](./tools.test.ts) | Regression tests for bash, grep, glob. |
| [tools.ts](./tools.ts) | The standard set of tools. |
| [types.ts](./types.ts) | The tool contract. A tool is something the model may call. The description and the schema are what the provider advertises; `run` is the executable side, which Phase 3 fills in (read, write, edit, bash, grep, glob, todo). |
| [validate.test.ts](./validate.test.ts) | Regression tests for validateArgs, toToolSpec. |
| [validate.ts](./validate.ts) | Validating a tool's arguments. The schema a tool declares is the schema its arguments are checked against: the model is told exactly what is expected, and what it sends is held to that. A tool with a broken schema is refused rather than run with whatever the model happened to send. |
| [walk.ts](./walk.ts) | Walking a directory, the way a search should. Git's ignored files are skipped, and so are the directories that are never worth searching: .git, node_modules and the usual build output. |
| [write.ts](./write.ts) | write — create a file, or replace what is in it. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
