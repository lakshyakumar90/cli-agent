/**
 * The decision: may this call happen?
 *
 * The order is the whole policy:
 *
 * 1. In plan mode nothing but the read-only tools runs.
 * 2. A path outside the workspace is always worth a question (never in
 *    yolo, where the user has said "do not ask").
 * 3. The rules decide, most specific first.
 * 4. A tool that asks for approval itself always asks.
 * 5. The mode decides.
 */

import { matchRule } from "./rules.js";
import type {
  PermissionAction,
  PermissionRequest,
  PermissionRule,
} from "./types.js";

export interface PermissionConfig {
  /** How much is allowed without asking. */
  mode: "ask" | "auto-edit" | "yolo" | "plan";
  /** The rules, most specific first. */
  rules?: PermissionRule[];
  /** The workspace paths must stay inside. Defaults to the working directory. */
  workspace?: string;
}

/** What should happen with this call? */
export function decidePermission(
  request: PermissionRequest,
  config: PermissionConfig,
): PermissionAction {
  // 1. Plan mode is read-only.
  if (config.mode === "plan" && request.effect !== "read") {
    return "deny";
  }

  // 2. Outside the workspace is a question, whatever the mode says.
  if (request.outsideWorkspace === true) {
    if (config.mode === "yolo") return "allow";
    // Plan mode has nobody to ask.
    if (config.mode === "plan") return "deny";
    return "ask";
  }

  // 3. The rules.
  const rule = matchRule(
    config.rules ?? [],
    request.tool,
    request.subject,
  );
  if (rule !== undefined) return rule.action;

  // 4. The tool asked for permission itself.
  if (request.needsApproval === true) return "ask";

  // 5. The mode.
  switch (config.mode) {
    case "yolo":
      return "allow";
    case "auto-edit":
      // Edits go through; commands still ask.
      return request.effect === "write" ? "allow" : "ask";
    case "plan":
      return "allow";
    case "ask":
    default:
      return request.effect === "read" ? "allow" : "ask";
  }
}

/** Why a call was refused, for the message the model sees. */
export function denialReason(
  request: PermissionRequest,
  action: PermissionAction,
): string {
  switch (action) {
    case "deny":
      if (request.effect !== "read" && request.outsideWorkspace !== true) {
        return "the agent is in plan mode, where only reading is allowed";
      }
      if (request.outsideWorkspace === true) {
        return `the path is outside the workspace: ${request.path ?? request.subject ?? "?"}`;
      }
      return `a rule refuses ${request.tool}`;
    default:
      return request.reason;
  }
}
