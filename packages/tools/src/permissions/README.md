# packages/tools/src/permissions

Pure permission decisions plus a shared live controller, rule matching, and execution wrappers.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [controller.test.ts](./controller.test.ts) | Regression tests for live permissions. |
| [controller.ts](./controller.ts) | Own live permission mode, literal session grants, pending approvals, policy changes, and cancellation. |
| [decide.ts](./decide.ts) | The decision: may this call happen? The order is the whole policy: |
| [index.ts](./index.ts) | Public exports for this module boundary. |
| [permissions.test.ts](./permissions.test.ts) | Regression tests for parsing rules, matching rules, deciding. |
| [rules.ts](./rules.ts) | Rules: how they are written and how they are matched. |
| [types.ts](./types.ts) | What the agent is allowed to do. The tools are powerful; the permissions are what keep them pointed. Four modes say how much is allowed without asking, and a list of rules says what is always allowed, always refused, or always worth a question. |
| [wrap.test.ts](./wrap.test.ts) | Regression tests for the permission wrapper. |
| [wrap.ts](./wrap.ts) | The tools, behind the permissions. Every tool that is wrapped is asked first. The answer is one of three: it runs, it is refused, or the user is asked. A refusal never reaches the tool: the model is told what happened, and carries on. |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
