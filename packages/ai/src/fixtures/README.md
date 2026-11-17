# The recorded streams

Each file is the body of a response, exactly as the vendor sent it. The
tests replay them: the provider adapter is given the recording instead of
a network, and everything it does with the bytes is checked.

They are made by `pnpm --filter @cli-agent/ai record:fixtures`, which
calls the real provider and writes down what came back.

| File | Where it came from |
| --- | --- |
| `gemini-stream.txt` | recorded: Gemini, a plain answer |
| `gemini-tool-call.txt` | recorded: Gemini, asking for a tool |
| `openai-compat-stream.txt` | recorded: the OpenAI Chat Completions format |
| `openai-compat-tool-call.txt` | recorded: the OpenAI Chat Completions format, asking for a tool |
| `codex-stream.txt` | recorded: the OpenAI Responses format, through a ChatGPT login |
| `codex-tool-call.txt` | recorded: the OpenAI Responses format, asking for a tool |
| `anthropic-stream.txt` | written by hand: no Anthropic key was near the machine |

The Anthropic one is the only one that was not recorded. It is written
from the format the adapter reads, and it is the one to watch: when an
Anthropic key is at hand, record it and the hand-written one can go.

The recordings hold what the vendors sent, secrets included in no case:
the bodies are answers, not requests, and the keys travel in the headers.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [anthropic-stream.txt](./anthropic-stream.txt) | Recorded anthropic stream wire bytes for adapter replay tests; consult the fixture README for provenance. |
| [codex-stream.txt](./codex-stream.txt) | Recorded codex stream wire bytes for adapter replay tests; consult the fixture README for provenance. |
| [codex-tool-call.txt](./codex-tool-call.txt) | Recorded codex tool call wire bytes for adapter replay tests; consult the fixture README for provenance. |
| [gemini-stream.txt](./gemini-stream.txt) | Recorded gemini stream wire bytes for adapter replay tests; consult the fixture README for provenance. |
| [gemini-tool-call.txt](./gemini-tool-call.txt) | Recorded gemini tool call wire bytes for adapter replay tests; consult the fixture README for provenance. |
| [openai-compat-stream.txt](./openai-compat-stream.txt) | Recorded openai compat stream wire bytes for adapter replay tests; consult the fixture README for provenance. |
| [openai-compat-tool-call.txt](./openai-compat-tool-call.txt) | Recorded openai compat tool call wire bytes for adapter replay tests; consult the fixture README for provenance. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
