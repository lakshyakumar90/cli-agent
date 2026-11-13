/**
 * Rules: how they are written and how they are matched.
 */

import type { PermissionAction, PermissionRule } from "./types.js";
import { globToRegExp } from "../grep.js";

/**
 * Parse rules written as text.
 *
 * One rule per line:
 *
 *   bash(git status) allow
 *   bash(rm *)       ask
 *   write(src/**)    deny
 *   read             allow
 *
 * A blank line and a line starting with "#" are ignored. A rule without an
 * action is refused rather than guessed at.
 */
export function parseRules(text: string): PermissionRule[] {
  const rules: PermissionRule[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const rule = parseRule(line);
    if (rule !== undefined) rules.push(rule);
  }

  return rules;
}

/** One line of rule text. */
export function parseRule(line: string): PermissionRule | undefined {
  const match = /^([A-Za-z_][\w-]*|\*)\s*(?:\((.*)\))?\s+(allow|deny|ask)$/i.exec(
    line.trim(),
  );
  if (match === null) return undefined;

  const [, tool, pattern, action] = match;
  return {
    tool: tool!.toLowerCase(),
    ...(pattern === undefined || pattern.length === 0 ? {} : { pattern }),
    action: action!.toLowerCase() as PermissionAction,
  };
}

/**
 * The first rule that matches, or nothing.
 *
 * The order matters: the first match wins, so the specific rules go before
 * the general ones.
 */
export function matchRule(
  rules: PermissionRule[],
  tool: string,
  subject: string | undefined,
): PermissionRule | undefined {
  for (const rule of rules) {
    if (rule.tool !== "*" && rule.tool !== tool) continue;
    if (rule.pattern === undefined) return rule;
    if (subject === undefined) continue;
    if (matchesPattern(rule.pattern, subject)) return rule;
  }
  return undefined;
}

/**
 * Does a glob match what the tool wants to do?
 *
 * A pattern without a wildcard has to match the whole thing, so
 * "bash(git status)" allows that command and nothing else.
 */
export function matchesPattern(pattern: string, subject: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return pattern === subject;
  }
  return globToRegExp(pattern).test(subject);
}
