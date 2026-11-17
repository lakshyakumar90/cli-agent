"use client";
import { useEffect, useId, useRef, useState } from "react";
import { CopyButton } from "./copy-button";
let renderQueue: Promise<unknown> = Promise.resolve();
export function Mermaid({
  source,
  title = "Architecture flowchart",
}: {
  source: string;
  title?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const container = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        renderQueue = renderQueue
          .catch(() => undefined)
          .then(async () => {
            try {
              const { default: mermaid } = await import("mermaid");
              mermaid.initialize({
                startOnLoad: false,
                securityLevel: "strict",
                theme: "base",
                fontFamily: "Manrope Variable, sans-serif",
                themeVariables: {
                  primaryColor: "#e4e9db",
                  primaryTextColor: "#252b25",
                  primaryBorderColor: "#4c633a",
                  lineColor: "#60665b",
                  secondaryColor: "#dde6cd",
                  tertiaryColor: "#f8f7f2",
                },
                flowchart: { htmlLabels: false },
              });
              const result = await mermaid.render(`diagram${id}`, source);
              if (!cancelled) setSvg(result.svg);
            } catch {
              if (!cancelled) setError(true);
            }
          });
      },
      { rootMargin: "200px" },
    );
    if (container.current) observer.observe(container.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [id, source]);
  return (
    <figure className="diagram" ref={container}>
      <figcaption>
        {title}
        <CopyButton text={source} label="Copy source" />
      </figcaption>
      {svg ? (
        <div
          className="diagram-svg"
          role="img"
          aria-label={title}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="diagram-loading" role="status">
          {error
            ? "Diagram preview unavailable. The Mermaid source is below."
            : "Preparing flowchart…"}
        </div>
      )}
      <details open={error}>
        <summary>View Mermaid source (.mmd)</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </figure>
  );
}
