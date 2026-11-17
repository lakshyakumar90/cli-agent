"use client";
import { useState } from "react";
import { Stage } from "./stageshow/stage";
import { Window } from "./stageshow/window";
import {
  Check,
  ArrowRight,
  Circle,
  GitBranch,
  ShieldCheck,
} from "lucide-react";
const scenarios = [
  {
    label: "Explore",
    prompt: "How does authentication work in this repo?",
    mode: "Plan",
    model: "codex/gpt-6.1-sol",
    thought: "Tracing the credential flow before suggesting changes.",
    tools: [
      "glob src/auth/**/*.ts",
      "read src/auth/session.ts",
      "grep refreshToken src/",
    ],
    answer:
      "The auth layer resolves environment credentials first, then the local store. Refresh happens before an expired token reaches a provider.",
  },
  {
    label: "Build",
    prompt: "Add validation to the settings form.",
    mode: "Auto-edit",
    model: "openrouter/your-model",
    thought: "Checking the form schema and existing validation patterns.",
    tools: [
      "read src/settings/form.tsx",
      "edit src/settings/schema.ts",
      "read src/settings/schema.test.ts",
    ],
    answer:
      "Added field validation using the existing schema. Shell commands still require approval in Auto-edit mode.",
  },
  {
    label: "Review",
    prompt: "/review",
    mode: "Read-only review",
    model: "anthropic/your-model",
    thought: "Reviewing the captured diff for correctness and missing tests.",
    tools: [
      "read src/auth/session.ts",
      "grep expiry src/auth/",
      "read src/auth/session.test.ts",
    ],
    answer:
      "Found an expired-token edge case. The review reports a finding with a file reference; it does not apply changes.",
  },
];
export function TerminalPreview() {
  const [active, setActive] = useState(0);
  const scenario = scenarios[active]!;
  return (
    <div className="preview-wrap">
      <div
        className="preview-tabs"
        role="tablist"
        aria-label="Example workflow"
        onKeyDown={(event) => {
          let next = active;
          if (event.key === "ArrowRight")
            next = (active + 1) % scenarios.length;
          else if (event.key === "ArrowLeft")
            next = (active - 1 + scenarios.length) % scenarios.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = scenarios.length - 1;
          else return;
          event.preventDefault();
          setActive(next);
          event.currentTarget
            .querySelectorAll<HTMLButtonElement>('[role="tab"]')
            [next]?.focus();
        }}
      >
        {scenarios.map((item, i) => (
          <button
            key={item.label}
            role="tab"
            aria-selected={i === active}
            tabIndex={i === active ? 0 : -1}
            aria-controls="terminal-example"
            id={`scenario-${i}`}
            onClick={() => setActive(i)}
          >
            {item.label}
            {i === active && <ArrowRight size={14} />}
          </button>
        ))}
        <span>Interactive preview</span>
      </div>
      <div
        className="terminal-preview"
        id="terminal-example"
        role="tabpanel"
        aria-labelledby={`scenario-${active}`}
      >
        <Stage
          width={1040}
          height={470}
          compact={{ below: 700, width: 358, height: 358 }}
          fidelity="realistic"
          theme="dark"
          className="agent-stage"
        >
          {(_state, _rect, layout) => (
            <Window
              chrome="terminal"
              title="agent — my-project"
              className="agent-window"
              style={{
                position: "absolute",
                left: layout === "compact" ? 0 : 24,
                top: 24,
                width: layout === "compact" ? 358 : 1040,
                height: 580,
              }}
            >
              <div className="terminal-bar" hidden>
                <span className="terminal-lights">
                  <i />
                  <i />
                  <i />
                </span>
                <span>agent — my-project</span>
                <span>
                  <GitBranch size={12} />
                  main
                </span>
              </div>
              <div className="terminal-body" aria-live="polite">
                <div className="terminal-prompt">
                  <span>›</span>
                  {layout === "compact"
                    ? [
                        "Trace the auth flow.",
                        "Validate the settings form.",
                        "/review",
                      ][active]
                    : scenario.prompt}
                </div>
                <div className="terminal-thinking">
                  Thinking
                  <span>
                    {layout === "compact"
                      ? [
                          "Tracing token refresh.",
                          "Checking the schema.",
                          "Checking the captured diff.",
                        ][active]
                      : scenario.thought}
                  </span>
                </div>
                <div className="terminal-tools">
                  {scenario.tools
                    .slice(0, layout === "compact" ? 2 : 3)
                    .map((tool) => (
                      <div key={tool}>
                        <Check size={13} />
                        <code>{tool}</code>
                      </div>
                    ))}
                </div>
                <p className="terminal-answer">
                  {layout === "compact"
                    ? [
                        "Credentials resolve locally. Refresh runs before token expiry.",
                        "Added schema validation. Shell commands still ask for approval.",
                        "Found an expiry edge case. Review reports findings without edits.",
                      ][active]
                    : scenario.answer}
                </p>
                <div className="terminal-input">
                  <span>›</span>
                  <span className="terminal-caret" />
                </div>
              </div>
              <div className="terminal-status">
                <span>
                  <ShieldCheck size={13} />
                  {scenario.mode}
                </span>
                <span>
                  <Circle size={7} fill="currentColor" />
                  {scenario.model}
                </span>
              </div>
            </Window>
          )}
        </Stage>
      </div>
      <p className="preview-caption">
        An example session. Real files, tools, and results depend on your
        project.
      </p>
    </div>
  );
}
