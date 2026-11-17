"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
export function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <button
      type="button"
      className="copy-button"
      onClick={copy}
      aria-label={
        state === "idle" ? label : state === "copied" ? "Copied" : "Copy failed"
      }
    >
      {state === "copied" ? <Check size={14} /> : <Copy size={14} />}
      <span role="status">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Select to copy"
            : label}
      </span>
    </button>
  );
}
