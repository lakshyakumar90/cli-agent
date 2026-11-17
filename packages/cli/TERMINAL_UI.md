# Interactive terminal

`InteractiveUi` is the only interactive input owner. Pi's `TuiMainScreen`
owns output, cursor movement, synchronized frames, resizing, and native
keyboard negotiation. `StreamTerminal` injects streams for headless tests.
Print, JSON, and RPC consumers remain independent.

`UiStore` holds display blocks. Transient notices, pickers, progress, and fold
actions do not enter model messages. `Transcript` caches Markdown components and
only re-parses an answer when its text changes. The question the user asked
sits at the margin, marked and in bold; the answer is indented and says which
model gave it. Supplied reasoning appears live under a `thinking` label, in a
six-line preview. Alt+I or `/inspect`
opens the complete latest thinking/tool output, including tool arguments.
Ctrl+T is not bound by the interactive UI. Only provider-supplied reasoning is shown.
Model changes are visible transcript markers and persist in the session UI sidecar;
changes requested during a running turn apply before the next queued prompt.
Selectors own their search input and keep the prompt editor and cursor intact.
The models of a provider sit under its name, and the name stays visible while
the list is scrolled. Approvals temporarily suspend the current dialog and
identify the requesting worker. An approval is a box: the request, the
arguments, the answers, and the cursor are all in it. Press `d` in an approval
to inspect the complete request before deciding. In a control, only the small
things are bold — the name of a tool, the label of the answer that is picked,
the name of a key — and the sentences that explain them are dim.

The frame of the session is as tall as the terminal and no taller. A frame
that is taller is written over the terminal, and the conversation ends up on
the screen twice with the middle of it cut; the conversation is trimmed to
the rows that are left, and the lines that did not fit are said to be above.
A tool call is drawn as the name of the tool and the whole of the command or
path it was given, and the output it produced is behind one keystroke with
its size said.

`SessionController` changes the active journal, model, transcript, checkpoints,
workers, and reviews together. Existing JSONL messages remain readable. Optional
versioned `.ui` sidecars store worker history, reasoning preferences, and reviews;
metadata and sidecars use temporary files and atomic renames. Interrupted workers
and reviews are not restarted automatically. Project-scoped session IDs accept
only letters, numbers, underscores, and hyphens.

`PermissionController` is shared by parent and worker tool wrappers. Decisions
are checked at execution time. Plan restrictions and deny rules override grants.
Session grants match literal actions, including command characters such as `*`.
Mode changes re-evaluate pending approvals. Cancelled requests settle once.

`WorkerManager` owns queue slots, cancellation, timeouts, worktrees, history,
follow-up queues, and lifecycle events. The model-facing task tool waits for the
same manager used by interactive controls. Workers launched through the UI report
back at a safe boundary before the parent's next turn. Worktrees remain available
after cancellation and are never silently discarded.

Code review captures a fixed Git diff using read-only commands and gives the
reviewer only read tools. Findings must match the structured schema; malformed
responses are failures, not clean reviews. Binary and oversized content is
disclosed. Reviews can be cancelled and compared against a fresh fingerprint.

Run `pnpm --filter @cli-agent/cli test` for screen-cell regressions using
`@xterm/headless`. Run `pnpm --filter @cli-agent/cli exec tsx scripts/terminal-smoke.ts`
inside a real PTY for native input, model selection, folding, and exit checks.
The smoke fixture makes no network requests and writes no session files.

The OpenCode CLI bridge runs the installed CLI in a private process. The private
server of the bridge is started once for the whole session and is shared by
every turn; a server per turn costs several seconds before the model is even
asked. It is stopped when the session ends. The server of the CLI is asked
where it listens, and the password line is not waited for: a server that was
given no password to ask for never prints one, and waiting for it costs the
whole timeout on every machine. A server that cannot be started is
remembered, so no turn pays for the attempt again. A local
plugin keeps the built-in profile intact, blocks native execution through a
hook and replacement executors, then registers a fresh guarded agent. Failure
to register leaves that agent unavailable. Host tools use a validated text protocol so the same permissions,
review restrictions, and worker execution apply to every provider. The tools
of the host keep the names they have at home, and the agent of the host has a
prompt of its own: the prompt of the machine is written for the tools of that
machine, and a model that reads it will reach for those. A model that asks
for a tool of the CLI anyway is refused by it — every native tool of the
agent is off — and the call is run by the host under its own permissions. A
model that puts the whole call in the arguments of a call it made up is read
out of them, and the JSON it wrote is read leniently, because a Windows path
in a string of JSON is not a JSON escape. JSONL framing
preserves partial chunks; successful process exit does not hide provider error
events or empty responses. The name of a failure is kept, and not only the
stack under it: a cold OpenCode catalog that can be read a second time is
read again. OpenCode free-tier quota failures are surfaced without
retrying them indefinitely. The subprocess has a two-minute deadline and supports
immediate cancellation. Authentication and provider configuration remain OpenCode's.
