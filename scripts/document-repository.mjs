/** Build a source-backed website file index and marked folder README sections. */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const excluded = new Set([
  "node_modules",
  ".next",
  ".git",
  ".turbo",
  "dist",
  "build",
  "out",
  "coverage",
  "test-results",
  "playwright-report",
]);
const notes = {
  "apps/web/mdx.d.ts":
    "Declare local MDX modules as typed React components for the explicit guide import registry.",
  ".gitignore":
    "Exclude dependencies, generated builds, local secrets, runtime state, and temporary artifacts from version control.",
  "AGENTS.md":
    "Repository-specific contributor instructions, including the requirement to read installed Turborepo docs before changing tasks.",
  "pnpm-lock.yaml":
    "Resolved workspace dependency versions and integrity metadata for reproducible installs.",
  "pnpm-workspace.yaml":
    "Declare apps and packages workspace globs and dependency build policies.",
  "apps/web/.gitignore":
    "Keep Next.js output, TypeScript caches, and Playwright artifacts out of version control.",
  "apps/web/DESIGN.md":
    "Record the original visual direction, tokens, typography, research references, and accessibility requirements.",
  "packages/cli/src/cli.ts":
    "Executable entry point: parse arguments, compose a session, and select interactive, print, JSON, or RPC output.",
  "packages/cli/src/session-controller.ts":
    "Switch saved sessions and persist model preferences, model-change markers, workers, and reviews atomically.",
  "packages/cli/src/review.ts":
    "Capture a read-only Git diff, fingerprint it, validate structured findings, and run a review without editing tools.",
  "packages/cli/src/catalog.ts":
    "Discover available models from authenticated providers, local CLI bridges, and extensions, retaining provider failures.",
  "packages/cli/src/ui/interactive.ts":
    "Compose the pi-tui screen, focused dialogs, prompt queue, permissions, model selection, sessions, and worker controls.",
  "packages/cli/src/ui/store.ts":
    "Accumulate display-only transcript blocks and update thinking and tool status in place by identity.",
  "packages/cli/src/ui/components.ts":
    "Render the transcript, thinking previews, searchable selectors, and scrollable detail views.",
  "packages/cli/src/ui/terminal.ts":
    "Adapt native or injected input/output streams to the pi-tui terminal interface.",
  "packages/core/src/agents/worker-manager.ts":
    "Own worker lifetimes, concurrency, cancellation, follow-ups, transcripts, and observable status.",
  "packages/tools/src/permissions/controller.ts":
    "Own live permission mode, literal session grants, pending approvals, policy changes, and cancellation.",
  "packages/ai/src/providers/local-opencode.ts":
    "Bridge OpenCode v2 JSONL into provider events, isolate native tools, validate host-tool requests, and surface process failures.",
  "apps/web/app/layout.tsx":
    "Root HTML shell, metadata, self-hosted fonts, shared header, and global stylesheet.",
  "apps/web/app/page.tsx":
    "Landing page: interactive terminal workflows, features, providers, source installation, and FAQ.",
  "apps/web/app/docs/[[...slug]]/page.tsx":
    "Generate MDX guide routes, metadata, grouped navigation, contents links, and adjacent-page controls.",
  "apps/web/app/globals.css":
    "Shared color and typography tokens, landing/docs styles, responsive layouts, focus states, and reduced-motion rules.",
  "apps/web/app/not-found.tsx":
    "Recoverable 404 page with links to documentation and home.",
  "apps/web/app/robots.ts":
    "Public crawler rules for the documentation website.",
  "apps/web/app/icon.svg": "Original terminal-prompt favicon.",
  "apps/web/components/brand.tsx":
    "Reusable original Agent wordmark and terminal-prompt SVG.",
  "apps/web/components/copy-button.tsx":
    "Clipboard button with explicit copied and failure feedback.",
  "apps/web/components/search.tsx":
    "Keyboard-accessible full-text guide search in a native modal dialog.",
  "apps/web/components/header.tsx":
    "Shared site navigation, source link, and server-populated documentation search.",
  "apps/web/components/terminal-preview.tsx":
    "Illustrative Explore, Build, and Review session tabs; no commands execute in the browser.",
  "apps/web/components/provider-switcher.tsx":
    "Provider connectivity tabs with requirements and copyable command examples.",
  "apps/web/components/code-block.tsx":
    "Server-side Shiki highlighting, code copying, and Mermaid fence detection.",
  "apps/web/components/mermaid.tsx":
    "Lazy, strictly secured Mermaid rendering with serialized work, captions, source, and fallback.",
  "apps/web/components/diagram.tsx":
    "Read an allowed local .mmd asset on the server and expose rendered/source/download views.",
  "apps/web/components/file-reference.tsx":
    "Search and group the checked-in source inventory with repository links.",
  "apps/web/lib/docs.ts":
    "Explicit MDX import registry with guide slugs, descriptions, groups, and titles.",
  "apps/web/lib/links.ts":
    "Browser-safe documentation URL and repository URL helpers.",
  "apps/web/lib/content.ts":
    "Server-only MDX reading, full-text search corpus, and heading extraction.",
  "apps/web/mdx-components.tsx":
    "Map MDX elements to highlighted code, responsive tables, callouts, diagrams, and the file guide.",
  "apps/web/next.config.mjs":
    "Configure local MDX, GFM, heading slugs, supported page extensions, and Next.js headers.",
  "apps/web/playwright.config.ts":
    "Start a production test server and run desktop/mobile browser checks.",
  "scripts/document-repository.mjs":
    "Generate the source-file reference and refresh marked README file maps while preserving handwritten content.",
};
const folders = {
  "": "Source map for the CLI runtime, documentation application, shared configuration, and maintenance scripts.",
  "packages/ai/scripts":
    "Provider streaming demos, live smoke tests, and fixture recording. Live scripts need provider access and may incur costs.",
  "packages/core/scripts":
    "Runnable agent-loop demos, permission/session/worker examples, and evaluation entry points.",
  "packages/cli/scripts":
    "Extension demos, terminal driving helpers, and a no-network native terminal smoke fixture.",
  "packages/ai/src/fixtures":
    "Recorded provider streaming bytes and their provenance notes, used for deterministic adapter replay tests.",
  apps: "Deployable application workspaces. The web app documents the terminal agent without running it in the browser.",
  "apps/web":
    "Next.js landing page and source-backed MDX documentation. Run `pnpm --filter @cli-agent/web dev` from the repository root.",
  "apps/web/app":
    "App Router routes, root layout, metadata, and responsive global styles.",
  "apps/web/app/docs":
    "Documentation route tree. Guides are compiled from local MDX content.",
  "apps/web/app/docs/[[...slug]]":
    "Optional catch-all route for the docs index and registered guide slugs.",
  "apps/web/components":
    "Reusable presentation and interaction components. Client-only behavior is limited to search, previews, clipboard controls, and diagram rendering.",
  "apps/web/content":
    "Checked-in documentation content and the generated repository inventory.",
  "apps/web/content/docs":
    "MDX usage guides and implementation walkthroughs. Register new guides in `lib/docs.ts`.",
  "apps/web/lib":
    "Navigation contracts and server content helpers. Keep Node filesystem code out of client components.",
  "apps/web/public": "Static assets served unchanged by Next.js.",
  "apps/web/public/diagrams":
    "Mermaid .mmd flowcharts used by MDX guides, available as source downloads.",
  "apps/web/scripts":
    "Node test helpers for content integrity and repository documentation coverage.",
  "apps/web/tests":
    "Production-browser checks for navigation, search, clipboard, diagrams, and responsive overflow.",
  packages:
    "Internal TypeScript runtime packages and shared development configuration.",
  "packages/ai":
    "Provider-neutral messages, model metadata, authentication, stream adapters, and fixtures. Run `pnpm --filter @cli-agent/ai test`.",
  "packages/ai/src":
    "Provider contracts, model registry, factory, streaming helpers, and normalized event handling.",
  "packages/ai/src/auth":
    "API key precedence, credential storage, OAuth/PKCE flows, loopback callbacks, and CLI credential import.",
  "packages/ai/src/providers":
    "Vendor wire-protocol adapters. Each translates to the shared event format and preserves required signatures.",
  "packages/ai/src/testing":
    "Deterministic provider doubles for repeatable protocol and runtime tests.",
  "packages/core":
    "Agent runtime: execution loop, context budgets, journals, workers, and extension discovery. Run `pnpm --filter @cli-agent/core test`.",
  "packages/core/src":
    "Conversation execution, prompt composition, context management, persistence, logging, and extension loaders.",
  "packages/core/src/agents":
    "Roles, worker lifetimes, task delegation, task boards, orchestration, and Git worktree isolation.",
  "packages/core/src/evals":
    "Disposable-repository task definitions and the evaluation runner.",
  "packages/tools":
    "Local capabilities, schema validation, MCP connectivity, and permission enforcement. Run `pnpm --filter @cli-agent/tools test`.",
  "packages/tools/src":
    "Read/write/edit/shell/search/checklist tools, execution helpers, path handling, validation, and MCP integration.",
  "packages/tools/src/permissions":
    "Pure permission decisions plus a shared live controller, rule matching, and execution wrappers.",
  "packages/tools/src/fixtures":
    "Small subprocess fixtures used by MCP integration tests.",
  "packages/cli":
    "Terminal command and runtime composition. Build with `pnpm --filter @cli-agent/cli build`; see `TERMINAL_UI.md` for renderer boundaries.",
  "packages/cli/src":
    "CLI entry point, arguments, provider catalog, session composition, review, and output consumers.",
  "packages/cli/src/ui":
    "Interactive pi-tui renderer, display state, selectors, editor helpers, and screen regressions. Legacy helpers coexist with the current main-screen renderer.",
  "packages/typescript-config":
    "Shared TypeScript compiler presets for Node, Next.js, and React library workspaces.",
  scripts:
    "Repository maintenance: source documentation generation and commit-by-commit verification.",
};
export async function sourceFiles(dir = "") {
  const entries = await readdir(path.join(repo, dir), { withFileTypes: true });
  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (
      excluded.has(entry.name) ||
      entry.name === "README.md" ||
      entry.name === "repository-index.json" ||
      entry.name === "next-env.d.ts" ||
      entry.name.endsWith(".tsbuildinfo") ||
      entry.name.endsWith(".tgz") ||
      entry.name === "agent" ||
      entry.name === "agent.exe"
    )
      continue;
    const relative = [dir, entry.name].filter(Boolean).join("/");
    if (entry.isDirectory()) {
      if (dir === "" && !["apps", "packages", "scripts"].includes(entry.name))
        continue;
      found.push(...(await sourceFiles(relative)));
    } else if (
      entry.isFile() &&
      (/\.(ts|tsx|mjs|js|json|jsonc|mdx|md|mmd|svg|yaml|txt|ps1|css)$/.test(
        entry.name,
      ) ||
        entry.name === ".gitignore")
    )
      found.push(relative);
  }
  return found;
}
async function describe(file) {
  if (notes[file]) return notes[file];
  const text = await readFile(path.join(repo, file), "utf8");
  const base = path.basename(file);
  if (/\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/.test(file)) {
    const suites = [
      ...text.matchAll(/(?:describe|test)\(\s*["'`]([^"'`]+)["'`]/g),
    ].map((m) => m[1]);
    return `Regression tests for ${suites.slice(0, 3).join(", ") || base.replace(/\.(test|spec)\..+$/, "").replaceAll("-", " ")}.`;
  }
  if (base === "package.json") {
    const pkg = JSON.parse(text);
    return `${pkg.name}: workspace manifest, ${Object.keys(pkg.scripts ?? {}).join(", ") || "package exports"}, and dependencies.`;
  }
  if (base === "tsconfig.json")
    return "Workspace TypeScript compiler settings and source inclusion.";
  if (base === "turbo.json")
    return "Turborepo task dependencies, source inputs, and cache outputs for this scope.";
  if (base === "vitest.config.ts")
    return "Vitest configuration for deterministic workspace tests.";
  if (base === "eslint.config.js")
    return "Workspace lint configuration using shared repository presets.";
  if (base.endsWith(".mdx"))
    return text
      .split(/\n\s*\n/)[0]
      .replaceAll("`", "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  if (base.endsWith(".mmd"))
    return `Mermaid source for the ${base.replace(".mmd", "").replaceAll("-", " ")} flowchart, rendered in the MDX guides.`;
  if (file.includes("/fixtures/") && base.endsWith(".txt"))
    return `Recorded ${base.replace(".txt", "").replaceAll("-", " ")} wire bytes for adapter replay tests; consult the fixture README for provenance.`;
  const header = /^\s*\/\*\*([\s\S]*?)\*\//.exec(text);
  if (header) {
    const comment = header[1]
      .split("\n")
      .map((line) => line.replace(/^\s*\* ?/, ""))
      .join("\n")
      .trim();
    return comment
      .split(/\n\s*\n/)
      .slice(0, 2)
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 420);
  }
  const symbols = [
    ...text.matchAll(
      /export\s+(?:async\s+)?(?:function|class|interface|type|const)\s+(\w+)/g,
    ),
  ].map((m) => m[1]);
  if (symbols.length)
    return `Defines ${symbols.slice(0, 7).join(", ")} for ${file.includes("/auth/") ? "authentication" : path.basename(path.dirname(file))} consumers.`;
  if (base === "index.ts") return "Public exports for this module boundary.";
  if (base.endsWith(".md"))
    return (
      text
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith("#"))
        .slice(0, 2)
        .join(" ")
        .slice(0, 300) || `Maintainer guide for ${base}.`
    );
  if (base.endsWith(".json"))
    return `Shared ${base.replace(".json", "").replaceAll("-", " ")} configuration preset.`;
  return `${base} supports ${folders[path.dirname(file).replaceAll("\\", "/")] ?? path.dirname(file)}.`;
}
export async function buildIndex() {
  return Promise.all(
    (await sourceFiles()).map(async (file) => ({
      path: file,
      description: await describe(file),
    })),
  );
}
export async function generate() {
  const index = await buildIndex();
  await mkdir(path.join(repo, "apps/web/content"), { recursive: true });
  await writeFile(
    path.join(repo, "apps/web/content/repository-index.json"),
    JSON.stringify(index, null, 2) + "\n",
  );
  if (process.argv.includes("--readmes")) {
    const directories = new Set([""]);
    for (const file of index) {
      let dir = path.posix.dirname(file.path);
      while (dir !== ".") {
        directories.add(dir);
        dir = path.posix.dirname(dir);
      }
    }
    for (const dir of directories) {
      const target = path.join(repo, dir, "README.md");
      let existing = "";
      try {
        existing = await readFile(target, "utf8");
      } catch {}
      const description =
        folders[dir] ??
        (dir.endsWith("/scripts")
          ? `Runnable demos and maintenance scripts for ${dir.split("/").at(-2)}. Run package scripts from the repository root.`
          : `Source and supporting files for ${dir || "the repository"}.`);
      if (!existing) existing = `# ${dir || "cli-agent"}\n\n${description}\n`;
      const children = [...directories]
        .filter((child) => child && path.posix.dirname(child) === (dir || "."))
        .sort();
      const local = index.filter(
        (file) => path.posix.dirname(file.path) === (dir || "."),
      );
      const lines = ["<!-- BEGIN SOURCE INDEX -->", "## Folder guide", ""];
      if (children.length) {
        lines.push(
          "### Subfolders",
          "",
          ...children.map(
            (child) =>
              `- [${path.posix.basename(child)}/](./${path.posix.basename(child)}/README.md): ${folders[child] ?? "Local source and file guide."}`,
          ),
          "",
        );
      }
      if (local.length) {
        lines.push(
          "### Files",
          "",
          "| File | Responsibility |",
          "| --- | --- |",
          ...local.map(
            (file) =>
              `| [${path.basename(file.path)}](./${path.basename(file.path)}) | ${file.description.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
          ),
          "",
        );
      }
      lines.push(
        "Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.",
        "<!-- END SOURCE INDEX -->",
      );
      const section = lines.join("\n");
      existing = existing
        .replace(
          /\n?<!-- BEGIN SOURCE INDEX -->[\s\S]*?<!-- END SOURCE INDEX -->\n?/g,
          "",
        )
        .trimEnd();
      await writeFile(target, existing + "\n\n" + section + "\n");
    }
  }
  console.log(
    `Documented ${index.length} maintained files${process.argv.includes("--readmes") ? " and refreshed folder READMEs" : ""}.`,
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await generate();
