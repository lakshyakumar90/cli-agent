/**
 * Keeping the secrets out.
 *
 * Everything the agent reads goes into a log: the requests, the tool
 * calls, the answers. A file it read may hold a key, and a log is a file
 * that is written to disk and kept.
 *
 * So what goes into the log is redacted first: the keys the process
 * knows are taken out by their value, and the shapes of the keys that
 * are written in the code are taken out by their shape.
 */

/** The name of an environment variable that holds something secret. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)/i;

/** The shortest value worth looking for. */
const MIN_LENGTH = 8;

/** The shapes of the keys that are written in the code. */
const PATTERNS: RegExp[] = [
  // OpenAI, Anthropic and the others.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // Google.
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  // GitHub.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Slack.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  // AWS.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // A JSON web token.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // A private key.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * A key that is written as a setting.
 *
 * The name of the setting is left alone - it says what the setting is -
 * and only the value is taken out.
 */
const SETTING =
  /\b(api[_-]?key|apikey|secret|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b(\s*[:=]\s*|["'\s]{1,4})["']?([A-Za-z0-9._~+/=-]{8,})["']?/gi;

/**
 * A token that is sent with a scheme.
 *
 * The scheme is left alone - it says what kind of token it is - and the
 * token itself is taken out.
 */
const SCHEME = /\b(Bearer|Basic|Token|Api-Key)(\s+)([A-Za-z0-9._~+/=-]{12,})/gi;

/** What a redacted thing looks like. */
export const REDACTED = "[redacted]";

/**
 * The secret values the process knows.
 *
 * The environment holds the keys the agent is using. They are taken out
 * of anything that is written down, whatever they look like.
 */
export function knownSecrets(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const secrets: string[] = [];

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_LENGTH) continue;
    if (!SECRET_NAME.test(name)) continue;
    secrets.push(value);
  }

  // The longest first: a key that holds another one is taken out whole.
  return secrets.sort((a, b) => b.length - a.length);
}

/**
 * Take the secrets out of a text.
 *
 * The values the process knows are taken out first, and then the shapes
 * that are written in the code.
 */
export function redact(
  text: string,
  options: { secrets?: string[] } = {},
): string {
  if (text.length === 0) return text;

  let out = text;

  const secrets = options.secrets ?? knownSecrets();
  for (const secret of secrets) {
    if (secret.length < MIN_LENGTH) continue;
    if (!out.includes(secret)) continue;
    out = out.split(secret).join(REDACTED);
  }

  for (const pattern of PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }

  // A key that is written as a setting keeps its name.
  out = out.replace(
    SETTING,
    (_match, name: string, between: string) => `${name}${between}${REDACTED}`,
  );

  // A token that is sent with a scheme keeps the scheme.
  out = out.replace(
    SCHEME,
    (_match, scheme: string, between: string) =>
      `${scheme}${between}${REDACTED}`,
  );

  return out;
}

/**
 * Take the secrets out of anything that is about to be written down.
 *
 * A string is redacted. An array or an object is walked. A number or a
 * boolean is left alone.
 */
export function redactValue(value: unknown, options?: { secrets?: string[] }): unknown {
  if (typeof value === "string") return redact(value, options ?? {});
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, options));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactValue(item, options);
    }
    return out;
  }
  return value;
}
