import { defineConfig } from "tsup";

// The workspace packages are source only (they are compiled by whoever
// imports them), so the CLI bundles them: what ships is one file that runs
// on its own.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node24",
  clean: true,
  outDir: "dist",
  noExternal: ["@cli-agent/ai", "@cli-agent/core", "@cli-agent/tools", "zod"],
  /**
   * The MCP SDK stays outside the bundle.
   *
   * It uses CommonJS inside (cross-spawn), and Node handles that
   * interop properly. A bundler cannot: it turns the `require` of
   * "child_process" into a call that throws, and the MCP servers never
   * answer.
   */
  external: ["@modelcontextprotocol/sdk"],
});
