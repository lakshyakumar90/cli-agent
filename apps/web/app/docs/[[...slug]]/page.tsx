import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen } from "lucide-react";
import { docs, docHref, sourceRoot } from "@/lib/docs";
import { rawDoc, headings } from "@/lib/content";
import { CopyButton } from "@/components/copy-button";
type Props = { params: Promise<{ slug?: string[] }> };
export const dynamicParams = false;
export function generateStaticParams() {
  return docs.map((doc) => ({ slug: doc.slug ? doc.slug.split("/") : [] }));
}
export async function generateMetadata({ params }: Props) {
  const { slug = [] } = await params;
  const doc = docs.find((d) => d.slug === slug.join("/"));
  return { title: doc?.title ?? "Not found", description: doc?.description };
}
export default async function DocPage({ params }: Props) {
  const { slug = [] } = await params;
  const index = docs.findIndex((doc) => doc.slug === slug.join("/"));
  const doc = docs[index];
  if (!doc) notFound();
  const { default: Content } = await doc.load();
  const source = await rawDoc(doc.slug);
  const toc = headings(source);
  const groups = [...new Set(docs.map((d) => d.group))];
  const previous = docs[index - 1],
    next = docs[index + 1];
  const navigation = (
    <nav aria-label="Documentation">
      {groups.map((group) => (
        <div className="doc-nav-group" key={group}>
          <h2>{group}</h2>
          {docs
            .filter((d) => d.group === group)
            .map((d) => (
              <Link
                key={d.slug}
                href={docHref(d.slug)}
                className={d.slug === doc.slug ? "active" : ""}
                aria-current={d.slug === doc.slug ? "page" : undefined}
              >
                {d.title}
              </Link>
            ))}
        </div>
      ))}
    </nav>
  );
  return (
    <div className="docs-shell">
      <aside className="docs-sidebar">
        <Link className="docs-home" href="/docs">
          <BookOpen size={17} />
          Documentation
        </Link>
        <div className="desktop-doc-nav">{navigation}</div>
        <details className="mobile-doc-nav">
          <summary>Browse documentation</summary>
          {navigation}
        </details>
        <div className="sidebar-note">
          Built in the open.
          <br />
          <a href={`${sourceRoot}/tree/main/packages`}>
            Read the source
            <ArrowUpRight size={12} />
          </a>
        </div>
      </aside>
      <main id="main" className="doc-main">
        <div className="doc-breadcrumb">
          Documentation<span>/</span>
          {doc.group}
        </div>
        <div className="doc-title-row">
          <h1>{doc.title}</h1>
          <CopyButton key={doc.slug} text={source} label="Copy page" />
        </div>
        <p className="doc-description">{doc.description}</p>
        <article className="prose">
          <Content />
        </article>
        <div className="doc-edit">
          <a
            href={`${sourceRoot}/edit/main/apps/web/content/docs/${doc.slug || "introduction"}.mdx`}
          >
            Improve this page
            <ArrowUpRight size={13} />
          </a>
          <span>Source-backed guides · MDX</span>
        </div>
        <nav className="doc-pagination" aria-label="Adjacent pages">
          {previous ? (
            <Link href={docHref(previous.slug)}>
              <span>
                <ArrowLeft size={14} />
                Previous
              </span>
              <strong>{previous.title}</strong>
            </Link>
          ) : (
            <div />
          )}
          {next && (
            <Link href={docHref(next.slug)}>
              <span>
                Next
                <ArrowRight size={14} />
              </span>
              <strong>{next.title}</strong>
            </Link>
          )}
        </nav>
      </main>
      <aside className="doc-toc">
        <p>On this page</p>
        <nav aria-label="On this page">
          {toc.map((h) => (
            <a
              key={h.id}
              href={`#${h.id}`}
              className={h.depth === 3 ? "nested" : ""}
            >
              {h.title}
            </a>
          ))}
        </nav>
        <div className="toc-help">
          Ready to try it?
          <Link href="/docs/installation">
            Install Agent
            <ArrowRight size={13} />
          </Link>
        </div>
      </aside>
    </div>
  );
}
