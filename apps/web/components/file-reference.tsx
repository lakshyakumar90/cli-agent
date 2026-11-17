"use client";
import { useState } from "react";
import { Search, FileCode2 } from "lucide-react";
import files from "@/content/repository-index.json";
import { sourceRoot } from "@/lib/links";
export function FileReference() {
  const [query, setQuery] = useState("");
  const filtered = files.filter((file) =>
    (file.path + " " + file.description)
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const groups: Record<string, typeof files> = {};
  for (const file of filtered) {
    const key = file.path
      .split("/")
      .slice(
        0,
        file.path.startsWith("packages/") || file.path.startsWith("apps/")
          ? 2
          : 1,
      )
      .join("/");
    (groups[key] ??= []).push(file);
  }
  return (
    <section className="file-reference" aria-label="Repository file reference">
      <label className="file-search">
        <Search size={17} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a file or responsibility…"
          aria-label="Find a source file"
        />
      </label>
      <p className="file-count" aria-live="polite">
        {filtered.length} of {files.length} maintained files
      </p>
      {Object.entries(groups).map(([group, entries]) => (
        <details key={group} open={query.length > 0}>
          <summary>
            <FileCode2 size={16} />
            {group}
            <span>{entries.length} files</span>
          </summary>
          <div className="file-list">
            {entries.map((file) => (
              <div key={file.path}>
                <a href={`${sourceRoot}/blob/main/${file.path}`}>
                  <code>{file.path}</code>
                </a>
                <p>{file.description}</p>
              </div>
            ))}
          </div>
        </details>
      ))}
      {!filtered.length && (
        <p>No files match. Try “loop”, “permissions”, or “mdx”.</p>
      )}
    </section>
  );
}
