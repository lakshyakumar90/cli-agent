import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { buildIndex } from "../../../scripts/document-repository.mjs";
const root = process.cwd();
test("every guide is registered and local documentation links resolve", async () => {
  const files = (await readdir(path.join(root, "content/docs"))).filter(
    (file) => file.endsWith(".mdx"),
  );
  const registry = await readFile(path.join(root, "lib/docs.ts"), "utf8");
  const slugs = new Set(
    files.map((file) =>
      file === "introduction.mdx" ? "" : file.replace(".mdx", ""),
    ),
  );
  for (const file of files) {
    assert.ok(
      registry.includes(`/docs/${file}`),
      `Unregistered guide: ${file}`,
    );
    const text = await readFile(path.join(root, "content/docs", file), "utf8");
    assert.ok(text.length > 800, `Guide too thin: ${file}`);
    for (const match of text.matchAll(
      /\]\(\/docs(?:\/([^#)]+))?(?:#[^)]+)?\)/g,
    ))
      assert.ok(
        slugs.has(match[1] ?? ""),
        `Broken link ${match[0]} in ${file}`,
      );
    for (const match of text.matchAll(/<Diagram name="([a-z-]+)"/g))
      await access(path.join(root, "public/diagrams", `${match[1]}.mmd`));
  }
});
test("repository reference matches maintained files and descriptions", async () => {
  const expected = await buildIndex();
  const actual = JSON.parse(
    await readFile(path.join(root, "content/repository-index.json"), "utf8"),
  );
  assert.deepEqual(
    actual,
    expected,
    "Run node scripts/document-repository.mjs from the repository root",
  );
  assert.ok(actual.length > 200);
  assert.ok(actual.every((file) => file.description.length > 15));
});
test("Mermaid sources have a flowchart declaration and no embedded HTML", async () => {
  for (const file of await readdir(path.join(root, "public/diagrams"))) {
    if (!file.endsWith(".mmd")) continue;
    const source = await readFile(
      path.join(root, "public/diagrams", file),
      "utf8",
    );
    assert.match(source, /^flowchart (TD|LR)/);
    assert.doesNotMatch(source, /<script|<iframe|click /i);
  }
});
