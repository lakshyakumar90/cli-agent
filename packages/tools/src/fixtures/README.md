# packages/tools/src/fixtures

Small subprocess fixtures used by MCP integration tests.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [echo-server.mjs](./echo-server.mjs) | A small MCP server, for the tests. It says hello with two tools: one that echoes what it is given, and one that fails. It talks over stdio, which is how most MCP servers are run. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
