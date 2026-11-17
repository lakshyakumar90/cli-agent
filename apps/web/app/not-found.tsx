import Link from "next/link";
export default function NotFound() {
  return (
    <main id="main" className="not-found">
      <span>404</span>
      <h1>This path ends here.</h1>
      <p>
        The page may have moved. Start with the guides or return to the terminal
        agent.
      </p>
      <Link className="button primary" href="/docs">
        Open documentation
      </Link>
      <Link className="button secondary" href="/">
        Back to home
      </Link>
    </main>
  );
}
