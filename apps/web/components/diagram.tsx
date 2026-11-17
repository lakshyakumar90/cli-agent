import { readFile } from "node:fs/promises";
import path from "node:path";
import { Mermaid } from "./mermaid";
export async function Diagram({
  name,
  title,
}: {
  name: string;
  title: string;
}) {
  if (!/^[a-z-]+$/.test(name)) throw new Error("Invalid diagram name");
  const source = await readFile(
    path.join(process.cwd(), "public/diagrams", `${name}.mmd`),
    "utf8",
  );
  return (
    <>
      <Mermaid source={source} title={title} />
      <a className="diagram-download" href={`/diagrams/${name}.mmd`} download>
        Download .mmd source
      </a>
    </>
  );
}
