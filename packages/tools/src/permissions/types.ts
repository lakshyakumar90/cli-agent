/**
 * What the agent is allowed to do.
 *
 * The tools are powerful; the permissions are what keep them pointed. Four
 * modes say how much is allowed without asking, and a list of rules says
 * what is always allowed, always refused, or always worth a question.
 */

/**
 * How much the agent may do without asking.
 *
 * - `ask`: file writes and commands are put to the user.
 * - `auto-edit`: file edits go through on their own; commands still ask.
 * - `yolo`: everything goes through on its own.
 * - `plan`: only the read-only tools run at all.
 */
export type PermissionMode = "ask" | "auto-edit" | "yolo" | "plan";

/** What a rule or a decision says. */
export type PermissionAction = "allow" | "deny" | "ask";

/**
 * One rule.
 *
 * The pattern is a glob, matched against the command (for a tool that runs
 * commands) or against the path, relative to the workspace (for a tool that
 * touches files). A rule without a pattern matches every call of the tool.
 */
export interface PermissionRule {
  /** The tool it applies to, or `"*"` for every tool. */
  tool: string;
  /** The glob, when the rule is not about every call. */
  pattern?: string;
  /** What to do when it matches. */
  action: PermissionAction;
}

/** What the agent is being asked to do. */
export interface PermissionRequest {
  /** The tool that wants to run. */
  tool: string;
  /** What the tool does to the world. */
  effect: "read" | "write" | "execute";
  /** The arguments the model sent. */
  args: unknown;
  /** What the rule is matched against: the command, or the path. */
  subject?: string;
  /** The path the tool touches, when it touches one. */
  path?: string;
  /** True when the path is outside the workspace. */
  outsideWorkspace?: boolean;
  /** The tool asked for approval itself. */
  needsApproval?: boolean;
  /** Why it is asking, in the words the user reads. */
  reason: string;
}

/** What the user said. */
export type PermissionDecision = "allow" | "deny" | "allow-always";

/** Asked when a call needs permission. */
export type AskPermission = (
  request: PermissionRequest,
) => Promise<PermissionDecision>;
