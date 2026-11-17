"use client";
import { useState } from "react";
import { CopyButton } from "./copy-button";
const providers = [
  {
    name: "OpenAI",
    ref: "openai/your-model",
    detail:
      "Use an OpenAI API key. The provider adapter normalizes streamed responses into the shared event format.",
    env: "OPENAI_API_KEY",
  },
  {
    name: "Anthropic",
    ref: "anthropic/your-model",
    detail:
      "Connect an Anthropic API key. Tool calls and provider-supplied reasoning flow through the same agent loop.",
    env: "ANTHROPIC_API_KEY",
  },
  {
    name: "Gemini",
    ref: "gemini/your-model",
    detail:
      "Connect a Gemini API key. The adapter preserves tool and thought signatures when the provider supplies them.",
    env: "GEMINI_API_KEY",
  },
  {
    name: "OpenRouter",
    ref: "openrouter/your-model",
    detail:
      "Use an OpenRouter key. The picker discovers available free models; availability and quotas can change.",
    env: "OPENROUTER_API_KEY",
  },
  {
    name: "Codex",
    ref: "codex/gpt-6.1-sol",
    detail:
      "Import an existing Codex CLI login when no agent credential is available. Model access depends on the account.",
    env: "Existing Codex CLI sign-in",
  },
  {
    name: "OpenCode",
    ref: "opencode-cli/provider/model",
    detail:
      "Use the locally installed OpenCode CLI and its provider connections. Host tools still pass through Agent permissions.",
    env: "OpenCode CLI v2, signed in",
  },
  {
    name: "Antigravity",
    ref: "antigravity/your-model",
    detail:
      "Connect the Google OAuth-backed Antigravity adapter. Configure the OAuth client for your environment.",
    env: "ANTIGRAVITY_ACCESS_TOKEN",
  },
];
export function ProviderSwitcher() {
  const [active, setActive] = useState(0);
  const provider = providers[active]!;
  const command = `agent --model ${provider.ref}`;
  return (
    <div className="provider-switcher">
      <div
        className="provider-list"
        role="tablist"
        aria-label="Model providers"
        onKeyDown={(event) => {
          let next = active;
          if (event.key === "ArrowRight")
            next = (active + 1) % providers.length;
          else if (event.key === "ArrowLeft")
            next = (active - 1 + providers.length) % providers.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = providers.length - 1;
          else return;
          event.preventDefault();
          setActive(next);
          event.currentTarget
            .querySelectorAll<HTMLButtonElement>('[role="tab"]')
            [next]?.focus();
        }}
      >
        {providers.map((p, i) => (
          <button
            key={p.name}
            id={`provider-${i}`}
            role="tab"
            aria-selected={active === i}
            tabIndex={active === i ? 0 : -1}
            aria-controls="provider-detail"
            onClick={() => setActive(i)}
          >
            <span className="provider-monogram" aria-hidden="true">
              {p.name.slice(0, 1)}
            </span>
            {p.name}
          </button>
        ))}
      </div>
      <div
        className="provider-detail"
        id="provider-detail"
        role="tabpanel"
        aria-labelledby={`provider-${active}`}
      >
        <div>
          <h3>{provider.name}, in your terminal.</h3>
          <p>{provider.detail}</p>
          <span className="connection-requirement">{provider.env}</span>
        </div>
        <div className="inline-command">
          <code>{command}</code>
          <CopyButton key={command} text={command} />
        </div>
        <small>
          Replace <code>your-model</code> with a model available to your
          account. Use <code>/model</code> to browse.
        </small>
      </div>
    </div>
  );
}
