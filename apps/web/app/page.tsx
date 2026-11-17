import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  GitBranch,
  ShieldCheck,
  Terminal,
  Workflow,
  Code2,
  BookOpen,
  Plug,
  ChevronRight,
} from "lucide-react";
import { TerminalPreview } from "@/components/terminal-preview";
import { ProviderSwitcher } from "@/components/provider-switcher";
import { CopyButton } from "@/components/copy-button";
import { Brand } from "@/components/brand";
import { sourceRoot } from "@/lib/links";
const install = `git clone ${sourceRoot}.git\ncd cli-agent\npnpm install\npnpm --filter @cli-agent/cli build\ncd packages/cli\nnpm pack\nnpm install -g ./cli-agent-cli-0.1.0.tgz\nagent`;
export default function Home() {
  return (
    <>
      <main id="main">
        <section className="hero page-width">
          <div className="hero-copy">
            <p className="eyebrow">A workspace, with agency.</p>
            <h1>
              Good work starts
              <br />
              with a conversation.
            </h1>
            <p>
              A coding agent that works where you do. Explore a codebase, make
              changes, and review the work—with the model and permissions you
              choose.
            </p>
            <div className="hero-actions">
              <Link className="button primary" href="/docs/installation">
                Start building
                <ArrowRight size={17} />
              </Link>
              <Link className="text-link" href="/docs/architecture">
                See how it works
                <ArrowUpRight size={15} />
              </Link>
            </div>
            <div className="hero-footnote">
              <span>
                <Check size={13} />
                Open source
              </span>
              <span>
                <Check size={13} />
                Local-first
              </span>
              <span>
                <Check size={13} />
                Model-flexible
              </span>
            </div>
          </div>
        </section>
        <section
          className="product-theatre page-width"
          aria-label="Agent in action"
        >
          <div className="theatre-heading">
            <span>01 / Inside your terminal</span>
            <span>Your code. Your models. Your decisions.</span>
          </div>
          <TerminalPreview />
        </section>
        <div className="capability-strip">
          <div className="page-width">
            <span>One agent. Your whole workflow.</span>
            <span>
              <Terminal size={16} />
              Explore & edit
            </span>
            <span>
              <ShieldCheck size={16} />
              Control access
            </span>
            <span>
              <GitBranch size={16} />
              Resume & branch
            </span>
            <span>
              <Workflow size={16} />
              Delegate & review
            </span>
          </div>
        </div>
        <section id="features" className="features-section page-width">
          <div className="section-intro">
            <h2>
              From a question
              <br />
              to a working change.
            </h2>
            <p>
              Keep the feedback loop close. Read the reasoning your model
              supplies, inspect tool output, and decide what happens next.
            </p>
          </div>
          <div className="feature-layout">
            <div className="feature-main">
              <div className="feature-icon">
                <ShieldCheck size={25} />
              </div>
              <h3>
                Give it room.
                <br />
                Keep the controls.
              </h3>
              <p>
                Start in Ask, allow workspace edits with Auto-edit, or explore
                in read-only Plan mode. Permissions are checked when a tool
                runs, including calls from workers.
              </p>
              <div className="permission-example">
                <div>
                  <span>read</span>
                  <span className="allowed">Allowed</span>
                </div>
                <div>
                  <span>edit</span>
                  <span className="approval">Ask first</span>
                </div>
                <div>
                  <span>bash</span>
                  <span className="approval">Ask first</span>
                </div>
              </div>
              <Link className="text-link" href="/docs/permissions">
                Understand permissions
                <ArrowRight size={15} />
              </Link>
            </div>
            <div className="feature-secondary">
              <div>
                <GitBranch size={23} />
                <h3>Pick up where you left off.</h3>
                <p>
                  Sessions save continuously. Resume a conversation, fork a
                  different approach, or inspect the complete transcript.
                </p>
                <Link href="/docs/sessions">
                  Explore sessions
                  <ArrowRight size={15} />
                </Link>
              </div>
              <div>
                <Workflow size={23} />
                <h3>More context. Less juggling.</h3>
                <p>
                  Give an explorer, coder, or reviewer a bounded task. Follow
                  its progress and bring the report back into your conversation.
                </p>
                <Link href="/docs/workers">
                  Meet the workers
                  <ArrowRight size={15} />
                </Link>
              </div>
            </div>
          </div>
        </section>
        <section id="connectivity" className="connectivity-section">
          <div className="page-width">
            <div className="section-intro">
              <h2>
                A different model.
                <br />
                The same workspace.
              </h2>
              <p>
                Connect API providers or use an existing CLI login. Switch
                models between turns without starting the conversation over.
              </p>
            </div>
            <ProviderSwitcher />
            <div className="mcp-note">
              <Plug size={21} />
              <p>
                <strong>Your tools connect, too.</strong> Add local or remote
                MCP servers, reusable skills, lifecycle hooks, and your own
                TypeScript extensions.
              </p>
              <Link href="/docs/extensions">
                Explore connections
                <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        </section>
        <section id="installation" className="install-section page-width">
          <div>
            <h2>
              Make yourself
              <br />
              at home.
            </h2>
            <p>
              Build from source, connect a provider, and open your project. The
              agent runs locally; model requests go to the provider you select.
            </p>
            <ul className="requirement-list">
              <li>
                <Check size={15} />
                Node.js 24 or newer
              </li>
              <li>
                <Check size={15} />
                pnpm 11.25.0 and Git
              </li>
              <li>
                <Check size={15} />A provider key or supported CLI sign-in
              </li>
            </ul>
            <Link className="text-link" href="/docs/installation">
              Full installation guide
              <ArrowRight size={16} />
            </Link>
          </div>
          <div className="install-code">
            <div>
              <span>
                <Terminal size={15} />
                Install from source
              </span>
              <CopyButton text={install} label="Copy commands" />
            </div>
            <pre>
              <code>
                <span className="code-comment">
                  # Clone, build, and install the command
                </span>
                {"\n" + install}
              </code>
            </pre>
            <p>
              Windows, macOS, and Linux. Bun is optional for a standalone
              binary.
            </p>
          </div>
        </section>
        <section className="build-section page-width">
          <div className="build-symbol">
            <Code2 size={42} />
          </div>
          <div>
            <h2>Nothing behind the curtain.</h2>
            <p>
              Learn how the providers, agent loop, permissions, and terminal fit
              together. Follow the diagrams. Find the file. Make it yours.
            </p>
          </div>
          <Link className="button secondary" href="/docs">
            <BookOpen size={17} />
            Read the build guide
            <ArrowRight size={16} />
          </Link>
        </section>
        <section className="faq-section page-width">
          <h2>A few good questions.</h2>
          <div>
            {[
              [
                "Does Agent come with a model subscription?",
                "No. Agent is the local client. Provider access, quotas, and costs belong to the account you connect. Free model availability can change.",
              ],
              [
                "Can I use my existing Codex or OpenCode sign-in?",
                "Yes. The Codex adapter can import an existing CLI credential when an agent credential is missing. The OpenCode bridge uses your locally installed OpenCode CLI and its connections.",
              ],
              [
                "Does my code stay on my machine?",
                "Tools run locally, but the conversation and relevant code context are sent to the selected model provider. Connected MCP services may also receive tool arguments. Review each provider’s policies.",
              ],
              [
                "Is Full access a sandbox?",
                "No. Permission modes are application policy. Full access permits tool calls subject to explicit deny rules and operating-system restrictions. Use a separate environment when you need isolation.",
              ],
            ].map(([q, a]) => (
              <details key={q}>
                <summary>
                  {q}
                  <ChevronRight size={18} />
                </summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
      <footer className="site-footer page-width">
        <div>
          <Brand />
          <p>A coding agent, built in the open.</p>
        </div>
        <nav aria-label="Footer">
          <Link href="/docs">Documentation</Link>
          <a href={sourceRoot}>
            Source code
            <ArrowUpRight size={13} />
          </a>
          <Link href="/docs/contributing">Contribute</Link>
        </nav>
        <span>TypeScript, all the way down.</span>
      </footer>
    </>
  );
}
