# packages/core/src/evals

Disposable-repository task definitions and the evaluation runner.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [runner.test.ts](./runner.test.ts) | Regression tests for the eval tasks, the eval suite. |
| [runner.ts](./runner.ts) | The eval runner. Every task runs in a throwaway repository: the files are written, the agent is asked the question, and a test is run in the repository afterwards. It passes when the test exits with zero. |
| [tasks.ts](./tasks.ts) | The eval tasks. Each task is a small repository, a question, and a test that says whether the agent did it. The repository is thrown away afterwards, so the agent can do anything to it. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
