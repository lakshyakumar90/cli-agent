import type { ComponentType } from "react";
export const docs = [
  {
    slug: "",
    title: "Introduction",
    group: "Get started",
    description: "Meet the agent and find your way around.",
    load: () => import("@/content/docs/introduction.mdx"),
  },
  {
    slug: "installation",
    title: "Installation",
    group: "Get started",
    description: "Build from source and install the agent command.",
    load: () => import("@/content/docs/installation.mdx"),
  },
  {
    slug: "quickstart",
    title: "Your first session",
    group: "Get started",
    description: "Connect a model and work on a repository.",
    load: () => import("@/content/docs/quickstart.mdx"),
  },
  {
    slug: "providers",
    title: "Models & connectivity",
    group: "Using Agent",
    description: "Providers, credentials, model selection, and MCP.",
    load: () => import("@/content/docs/providers.mdx"),
  },
  {
    slug: "permissions",
    title: "Permissions",
    group: "Using Agent",
    description: "Understand Ask, Auto-edit, Plan, and Full access.",
    load: () => import("@/content/docs/permissions.mdx"),
  },
  {
    slug: "sessions",
    title: "Sessions & context",
    group: "Using Agent",
    description: "Resume, fork, inspect, and compact a conversation.",
    load: () => import("@/content/docs/sessions.mdx"),
  },
  {
    slug: "workers",
    title: "Workers & reviews",
    group: "Using Agent",
    description: "Delegate bounded tasks and inspect read-only reviews.",
    load: () => import("@/content/docs/workers.mdx"),
  },
  {
    slug: "extensions",
    title: "Extending the agent",
    group: "Using Agent",
    description:
      "Connect MCP, skills, hooks, commands, and TypeScript extensions.",
    load: () => import("@/content/docs/extensions.mdx"),
  },
  {
    slug: "architecture",
    title: "Architecture",
    group: "How it is built",
    description: "The tech stack, package boundaries, and design decisions.",
    load: () => import("@/content/docs/architecture.mdx"),
  },
  {
    slug: "agent-loop",
    title: "The agent loop",
    group: "How it is built",
    description: "Trace a prompt through streaming, tools, and persistence.",
    load: () => import("@/content/docs/agent-loop.mdx"),
  },
  {
    slug: "terminal-ui",
    title: "The terminal UI",
    group: "How it is built",
    description: "Differential rendering, display state, and focused input.",
    load: () => import("@/content/docs/terminal-ui.mdx"),
  },
  {
    slug: "repository",
    title: "Repository & file guide",
    group: "How it is built",
    description: "Explore every maintained source folder and file.",
    load: () => import("@/content/docs/repository.mdx"),
  },
  {
    slug: "web",
    title: "Building this website",
    group: "How it is built",
    description: "Next.js, MDX, search, code highlighting, and Mermaid.",
    load: () => import("@/content/docs/web.mdx"),
  },
  {
    slug: "decisions",
    title: "Decisions & alternatives",
    group: "Engineering decisions",
    description:
      "Why this stack, competing options, complexity, and when to change course.",
    load: () => import("@/content/docs/decisions.mdx"),
  },
  {
    slug: "infrastructure",
    title: "Infrastructure & deployment",
    group: "Engineering decisions",
    description:
      "Local execution, hosting choices, isolation, operations, and cost tradeoffs.",
    load: () => import("@/content/docs/infrastructure.mdx"),
  },
  {
    slug: "performance",
    title: "Performance & measurement",
    group: "Engineering decisions",
    description:
      "Current optimizations, scale limits, evidence, and reproducible measurements.",
    load: () => import("@/content/docs/performance.mdx"),
  },
  {
    slug: "contributing",
    title: "Development & testing",
    group: "Reference",
    description: "Package scripts, verification, and contributor workflows.",
    load: () => import("@/content/docs/contributing.mdx"),
  },
  {
    slug: "commands",
    title: "Command reference",
    group: "Reference",
    description: "CLI flags, slash commands, and keyboard shortcuts.",
    load: () => import("@/content/docs/commands.mdx"),
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    group: "Reference",
    description:
      "Recover from credentials, quota, shell, and connection failures.",
    load: () => import("@/content/docs/troubleshooting.mdx"),
  },
] satisfies {
  slug: string;
  title: string;
  group: string;
  description: string;
  load: () => Promise<{ default: ComponentType }>;
}[];
export const docHref = (slug: string) => (slug ? `/docs/${slug}` : "/docs");
export const sourceRoot = "https://github.com/lakshyakumar90/cli-agent";
