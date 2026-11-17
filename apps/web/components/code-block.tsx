import { codeToHtml, bundledLanguages } from "shiki";
import type { ReactElement } from "react";
import { CopyButton } from "./copy-button";
import { Mermaid } from "./mermaid";
export async function CodeBlock({
  children,
}: {
  children?: ReactElement<{ children?: string; className?: string }>;
}) {
  const code = String(children?.props.children ?? "").replace(/\n$/, "");
  const language =
    children?.props.className?.replace("language-", "") ?? "text";
  if (language === "mermaid" || language === "mmd")
    return <Mermaid source={code} />;
  const lang =
    language in bundledLanguages
      ? (language as keyof typeof bundledLanguages)
      : "text";
  const html = await codeToHtml(code, { lang, theme: "github-light" });
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language}</span>
        <CopyButton text={code} />
      </div>
      <div
        className="highlighted-code"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
