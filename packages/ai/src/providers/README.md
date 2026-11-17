# packages/ai/src/providers

Vendor wire-protocol adapters. Each translates to the shared event format and preserves required signatures.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [anthropic.test.ts](./anthropic.test.ts) | Regression tests for anthropic stream, anthropic request, anthropic errors. |
| [anthropic.ts](./anthropic.ts) | Anthropic provider (`POST {baseUrl}/messages`, SSE). Anthropic's wire format differs from OpenAI's in ways this adapter hides: - content is a list of typed blocks, not a message string; - tool results are `user` messages containing `tool_result` blocks, and all results answering one assistant turn must share a single user message; - `max_tokens` is mandatory; - auth is `x-api-key` (or a bearer token for OAuth-style s |
| [antigravity.test.ts](./antigravity.test.ts) | Regression tests for antigravity, antigravity discoverProject. |
| [antigravity.ts](./antigravity.ts) | Google Antigravity (Cloud Code Assist) provider. Antigravity and the Gemini CLI talk to the same private backend, and its wire format is the Gemini one: `contents`, `parts`, `functionCall`, SSE chunks. Only three things differ, all of them confined to this file: |
| [codex.test.ts](./codex.test.ts) | Regression tests for codex preset. |
| [codex.ts](./codex.ts) | OpenAI Codex provider. This is the backend the Codex CLI itself talks to: a ChatGPT subscription endpoint, not the public API. It speaks the Responses wire format, so the whole translation lives in `responses.ts`; only four things differ here: |
| [gemini.test.ts](./gemini.test.ts) | Regression tests for gemini stream, gemini request, gemini errors. |
| [gemini.ts](./gemini.ts) | Google Gemini provider. Speaks `streamGenerateContent` over SSE — the wire format shared by the Gemini API and the Antigravity / Gemini CLI backend in ./antigravity.ts, so both share this one implementation. |
| [local-opencode.test.ts](./local-opencode.test.ts) | Regression tests for local opencode. |
| [local-opencode.ts](./local-opencode.ts) | Bridge OpenCode v2 JSONL into provider events, isolate native tools, validate host-tool requests, and surface process failures. |
| [normalization.test.ts](./normalization.test.ts) | Regression tests for normalization. |
| [openai-compat.test.ts](./openai-compat.test.ts) | Regression tests for openaiCompat stream, openaiCompat request, openaiCompat errors. |
| [openai-compat.ts](./openai-compat.ts) | OpenAI-compatible provider. One adapter covers OpenAI, OpenCode Zen, OpenRouter, Ollama, LM Studio and vLLM — anything that speaks `POST {baseUrl}/chat/completions` with SSE streaming. Only `baseUrl`, auth and model metadata differ. |
| [responses.test.ts](./responses.test.ts) | Regression tests for responses stream, responses tool calls, responses stop reasons. |
| [responses.ts](./responses.ts) | OpenAI Responses API provider (`POST {baseUrl}/responses`, SSE). Shares OpenAI's identity/auth with the chat-completions adapter, but not its wire format: `input` is a flat list of typed items, tools are flattened, the system prompt is `instructions`, and the stream is a sequence of named `response.*` events. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
