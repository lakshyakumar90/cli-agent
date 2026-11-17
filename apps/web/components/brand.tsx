import Link from "next/link";
export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="Agent home">
      <span>
        agent<span className="brand-dot">_</span>
      </span>
    </Link>
  );
}
