# packages/ai/src/testing

Deterministic provider doubles for repeatable protocol and runtime tests.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [mock-providers.ts](./mock-providers.ts) | A local server that speaks two real provider wire formats. It exists so the registry can be exercised end to end — real HTTP, real SSE, real adapters — without an API key: one endpoint answers in OpenAI's `chat.completion.chunk` shape, the other in Anthropic's named-event shape. The point of the registry is that the *same* code drives both. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
