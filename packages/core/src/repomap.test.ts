import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRepoMap, renderRepoMap, symbolsIn } from "./repomap.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-map-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the repo map", () => {
  it("finds the symbols in a file", async () => {
    await writeFile(
      join(directory, "a.ts"),
      [
        "export function greet(name: string) {}",
        "export class Thing {}",
        "export interface Options {}",
        "export type Name = string;",
        "const internal = 1;",
      ].join("\n"),
      "utf8",
    );

    const symbols = await symbolsIn(join(directory, "a.ts"));

    expect(symbols).toContain("greet");
    expect(symbols).toContain("Thing");
    expect(symbols).toContain("Options");
    expect(symbols).toContain("Name");
    expect(symbols).not.toContain("internal");
  });

  it("maps the project", async () => {
    await writeFile(
      join(directory, "a.ts"),
      "export function greet() {}\n",
      "utf8",
    );
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(
      join(directory, "src", "b.ts"),
      "export class Thing {}\n",
      "utf8",
    );

    const map = await buildRepoMap(directory);
    const paths = map.map((entry) => entry.path);

    expect(paths).toContain("a.ts");
    expect(paths).toContain("src/b.ts");
  });

  it("leaves a file without symbols out", async () => {
    await writeFile(join(directory, "readme.md"), "hello\n", "utf8");

    const map = await buildRepoMap(directory);

    expect(map).toEqual([]);
  });

  it("renders a compact outline", async () => {
    const rendered = renderRepoMap([
      { path: "a.ts", symbols: ["greet", "Thing"] },
      { path: "src/b.ts", symbols: ["Other"] },
    ]);

    expect(rendered).toContain("a.ts: greet, Thing");
    expect(rendered).toContain("src/b.ts: Other");
  });

  it("renders nothing when there is nothing", () => {
    expect(renderRepoMap([])).toBe("");
  });
});



