# packages/ai/scripts

Runnable demos and maintenance scripts for ai. Run package scripts from the repository root.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [demo-stream.ts](./demo-stream.ts) | Phase 1 demo: one loop, two providers. The registry resolves a `"provider/model"` ref to a provider, and the same `for await` loop streams from whichever backend it points at. With API keys in the environment this talks to the real APIs; without them it falls back to a local server that speaks both wire formats, so the code path is the same either way. |
| [diag-opencode.ts](./diag-opencode.ts) | Temporary diagnostic: drive the real local opencode provider and print everything it does. Used while fixing the "Unavailable" and "no response" reports. Delete when done. |
| [live-check.ts](./live-check.ts) | Live check of the local OpenCode provider against the installed CLI. It answers the questions the unit tests cannot: 1. can the catalog of the CLI be read (the "Unavailable" report)? 2. does a turn come back with text (the "no response" report)? 3. how long does each part take (the "too slow" report)? |
| [record-fixtures.ts](./record-fixtures.ts) | Record the streams the vendors send. The tests replay these instead of writing the wire format out by hand, so a change in the format shows up as a failing test. |
| [smoke-live.ts](./smoke-live.ts) | Live smoke test: stream from every provider you have credentials for. The credentials come from the environment first, then from the store the agent keeps (`~/.myagent/auth.json`), then from the CLIs already logged in on this machine: |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
