# packages/ai/src

Provider contracts, model registry, factory, streaming helpers, and normalized event handling.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Subfolders

- [auth/](./auth/README.md): API key precedence, credential storage, OAuth/PKCE flows, loopback callbacks, and CLI credential import.
- [fixtures/](./fixtures/README.md): Recorded provider streaming bytes and their provenance notes, used for deterministic adapter replay tests.
- [providers/](./providers/README.md): Vendor wire-protocol adapters. Each translates to the shared event format and preserves required signatures.
- [testing/](./testing/README.md): Deterministic provider doubles for repeatable protocol and runtime tests.

### Files

| File | Responsibility |
| --- | --- |
| [available.test.ts](./available.test.ts) | Regression tests for what a provider can serve, the free models. |
| [errors.ts](./errors.ts) | Errors thrown by provider adapters, in a shape the agent loop can act on. |
| [factory.test.ts](./factory.test.ts) | Regression tests for the provider factory. |
| [factory.ts](./factory.ts) | Building a provider from an id. The registry resolves "provider/model" refs; this builds the provider behind the id, with the credentials the auth layer finds (the environment first, then auth.json). |
| [fake.ts](./fake.ts) | The fake provider. A provider that answers what it is told to answer, so a test can say what the model says and what it does. It is the same thing for every test: the loop, the tools, the permissions and the sessions can all be tried without a network and without a key. |
| [fixtures.test.ts](./fixtures.test.ts) | Regression tests for the Gemini adapter, on a recorded stream, the OpenAI adapter, on a recorded stream, the Codex adapter, on a recorded stream. |
| [fixtures.ts](./fixtures.ts) | The recorded streams. A provider adapter is only as good as the bytes it is given. These are the bytes the vendors actually sent, recorded as they came, and the tests replay them: a change in the wire format shows up as a test that fails, not as an agent that breaks in the middle of a task. |
| [index.ts](./index.ts) | Public exports for this module boundary. |
| [missing-provider.test.ts](./missing-provider.test.ts) | Regression tests for a provider with no credentials. |
| [models.test.ts](./models.test.ts) | Regression tests for model table, pricing, cost estimation. |
| [models.ts](./models.ts) | The model table. One place that knows what each model costs and what it can do, so later phases can budget tokens and pick a model without hard-coding vendor knowledge. Prices are per **million** tokens, in USD. |
| [registry.test.ts](./registry.test.ts) | Regression tests for provider registry, streaming through the registry. |
| [registry.ts](./registry.ts) | One streaming entry point for every provider. The registry holds providers under short ids (`anthropic`, `codex`, `opencode`, …) and resolves `"provider/model"` refs to them, so the agent loop and the CLI can switch backends by changing one string. |
| [sse.ts](./sse.ts) | Minimal `text/event-stream` parser. Shared by every adapter that speaks SSE (OpenAI-compatible, Anthropic). Handles chunk boundaries that split a line, CRLF vs LF, multi-line `data:` fields, `:` comments / keep-alives, and streams that end without the final blank line. |
| [stream.ts](./stream.ts) | The shared streaming call. Every provider adapter takes the same request, so this is the only place that fills in the defaults. The same loop works for every backend, which is the point of the provider layer. |
| [types.ts](./types.ts) | Unified provider types. Every adapter (OpenAI-compatible, Anthropic, Gemini, …) translates its wire format into these shapes, so nothing above this layer ever imports a vendor SDK. Everything here is plain JSON, which is what makes sessions saveable and replayable in Phase 6. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
