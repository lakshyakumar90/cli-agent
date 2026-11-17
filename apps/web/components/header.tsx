import Link from "next/link";
import { ArrowUpRight, GitBranch } from "lucide-react";
import { Brand } from "./brand";
import { DocsSearch } from "./search";
import { searchDocuments } from "@/lib/content";
import { sourceRoot } from "@/lib/docs";
export async function Header() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Brand />
        <nav aria-label="Main navigation">
          <Link href="/#features">Features</Link>
          <Link href="/#connectivity">Connectivity</Link>
          <Link href="/docs">Documentation</Link>
        </nav>
        <div className="header-actions">
          <DocsSearch documents={await searchDocuments()} />
          <a
            href={sourceRoot}
            className="github-link"
            aria-label="Agent source on GitHub"
          >
            <GitBranch size={19} />
            <span>GitHub</span>
            <ArrowUpRight size={13} />
          </a>
        </div>
      </div>
    </header>
  );
}
