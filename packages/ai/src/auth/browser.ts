/**
 * Best-effort browser launch for the OAuth flow.
 *
 * Headless machines are normal (SSH, containers, CI), so a failure here is not
 * an error: the caller also prints the URL, and the user can paste it anywhere.
 */

import { spawn } from "node:child_process";

export function openBrowser(url: string): boolean {
  const command =
    process.platform === "win32"
      ? // `start` is a cmd builtin; the empty argument is the window title.
        { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };

  try {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      // No browser available; the printed URL is the fallback.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}