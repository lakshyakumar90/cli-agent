"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Search, X, CornerDownLeft } from "lucide-react";
import { docHref } from "@/lib/links";
type Document = { slug: string; title: string; group: string; text: string };
export function DocsSearch({ documents }: { documents: Document[] }) {
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  function open() {
    dialog.current?.showModal();
    input.current?.focus();
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (dialog.current?.open) dialog.current.close();
        else open();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const results = documents
    .filter((doc) =>
      words.every((word) =>
        (doc.title + " " + doc.text).toLowerCase().includes(word),
      ),
    )
    .sort(
      (a, b) =>
        Number(b.title.toLowerCase().includes(query.toLowerCase())) -
        Number(a.title.toLowerCase().includes(query.toLowerCase())),
    )
    .slice(0, 8);
  return (
    <>
      <button
        className="search-trigger"
        onClick={open}
        aria-label="Search documentation"
      >
        <Search size={16} />
        <span>Search documentation</span>
        <kbd>⌘ K</kbd>
      </button>
      <dialog
        ref={dialog}
        className="search-dialog"
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current?.close();
        }}
        aria-label="Search documentation"
      >
        <div className="search-box">
          <Search size={20} />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search guides, commands, architecture…"
            aria-label="Search guides"
          />
          <button
            className="icon-button"
            aria-label="Close search"
            onClick={() => dialog.current?.close()}
          >
            <X size={18} />
          </button>
        </div>
        <div className="search-results">
          {results.length ? (
            results.map((doc) => {
              const position = doc.text.toLowerCase().indexOf(words[0] ?? "");
              const snippet = doc.text.slice(
                Math.max(0, position - 45),
                Math.max(0, position - 45) + 150,
              );
              return (
                <Link
                  key={doc.slug}
                  href={docHref(doc.slug)}
                  onClick={() => dialog.current?.close()}
                >
                  <span className="search-group">{doc.group}</span>
                  <strong>
                    {doc.title}
                    <CornerDownLeft size={15} />
                  </strong>
                  <small>{snippet}…</small>
                </Link>
              );
            })
          ) : (
            <p className="search-empty">
              No guide matches “{query}”. Try a command or file name.
            </p>
          )}
        </div>
        <div className="search-hint">
          Tab to a result · Enter to open · Escape to close
        </div>
      </dialog>
    </>
  );
}
