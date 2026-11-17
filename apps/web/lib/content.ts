import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import GithubSlugger from "github-slugger";
import { docs } from "./docs";
export async function rawDoc(slug: string) {
  return readFile(
    path.join(process.cwd(), "content/docs", `${slug || "introduction"}.mdx`),
    "utf8",
  );
}
export function headings(source: string) {
  const slugger = new GithubSlugger();
  return [
    ...source.replace(/```[\s\S]*?```/g, "").matchAll(/^(#{2,3}) (.+)$/gm),
  ].map((match) => ({
    title: match[2]!,
    id: slugger.slug(match[2]!),
    depth: match[1]!.length,
  }));
}
export async function searchDocuments() {
  return Promise.all(
    docs.map(async (doc) => ({
      slug: doc.slug,
      title: doc.title,
      group: doc.group,
      text: (await rawDoc(doc.slug))
        .replace(/<[^>]+>/g, " ")
        .replace(/[#*`|]/g, " ")
        .replace(/\s+/g, " "),
    })),
  );
}
