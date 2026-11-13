/**
 * .gitignore rules.
 *
 * The search tools skip what git ignores, so a search does not wander into
 * node_modules or a build directory. This is a practical subset of the
 * format: patterns, directory patterns, anchoring and negation.
 */

/** One gitignore rule. */
interface Rule {
  pattern: RegExp;
  negate: boolean;
  directoryOnly: boolean;
}

export class IgnoreRules {
  private readonly rules: Rule[];

  constructor(rules: Rule[] = []) {
    this.rules = rules;
  }

  /** Are there any rules at all? */
  get isEmpty(): boolean {
    return this.rules.length === 0;
  }

  /** The rules of one .gitignore file. */
  static fromFile(content: string): IgnoreRules {
    const rules: Rule[] = [];

    for (const raw of content.split(/\r?\n/)) {
      const rule = parseRule(raw);
      if (rule !== undefined) rules.push(rule);
    }

    return new IgnoreRules(rules);
  }

  /** Nothing is ignored. */
  static none(): IgnoreRules {
    return new IgnoreRules();
  }

  /** Is this path ignored? */
  ignores(relativePath: string, isDirectory: boolean): boolean {
    if (this.rules.length === 0) return false;

    const path = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
    let ignored = false;

    for (const rule of this.rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (!rule.pattern.test(path)) continue;
      ignored = !rule.negate;
    }

    return ignored;
  }
}

function parseRule(raw: string): Rule | undefined {
  let line = raw.trim();
  if (line.length === 0 || line.startsWith("#")) return undefined;

  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  }

  let directoryOnly = false;
  if (line.endsWith("/")) {
    directoryOnly = true;
    line = line.slice(0, -1);
  }
  if (line.length === 0) return undefined;

  // A pattern with a slash in it belongs to the directory of the file it is
  // in; one without matches at any depth.
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);

  const body = line
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*")
    .replace(/\{([^}]*)\}/g, (_, group: string) =>
      `(${group.split(",").map((part) => part.trim()).join("|")})`,
    );

  const prefix = anchored ? "" : "(?:.*/)?";
  return {
    pattern: new RegExp(`^${prefix}${body}(?:/.*)?$`),
    negate,
    directoryOnly,
  };
}
