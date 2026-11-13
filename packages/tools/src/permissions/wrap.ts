/**
 * The tools, behind the permissions.
 *
 * Every tool that is wrapped is asked first. The answer is one of three:
 * it runs, it is refused, or the user is asked. A refusal never reaches the
 * tool: the model is told what happened, and carries on.
 */

import { isAbsolute, relative, sep } from "node:path";
import type { Tool, ToolContext } from "../types.js";
import { resolvePath } from "../paths.js";
import { decidePermission, denialReason, type PermissionConfig } from "./decide.js";
import type {
  AskPermission,
  PermissionDecision,
  PermissionRequest,
  PermissionRule,
} from "./types.js";

export interface PermissionOptions extends PermissionConfig {
  /** Asked when a call needs permission. Without it, nothing is allowed. */
  ask?: AskPermission;
}

/**
 * Wrap the tools with the permission layer.
 *
 * The rules live in the wrapper, so an "allow always" the user gives lasts
 * for the session.
 */
export function withPermissions(
  tools: Tool[],
  options: PermissionOptions,
): Tool[] {
  const rules: PermissionRule[] = [...(options.rules ?? [])];

  return tools.map((tool) => wrapTool(tool, options, rules));
}

/** One tool, behind the permissions. */
export function wrapTool(
  tool: Tool,
  options: PermissionOptions,
  rules: PermissionRule[],
): Tool {
  const wrapped: Tool = {
    ...tool,
    async run(args: any, ctx: ToolContext) {
      const workspace = options.workspace ?? ctx.cwd;
      const request = describeRequest(tool, args, ctx, workspace);

      const action = decidePermission(request, { ...options, rules });
      if (action === "deny") {
        return {
          output: `permission denied: ${denialReason(request, action)}`,
          isError: true,
        };
      }

      if (action === "ask") {
        const ask = options.ask;
        if (ask === undefined) {
          return {
            output: `permission denied: ${request.reason} (there is nobody to ask)`,
            isError: true,
          };
        }

        const decision: PermissionDecision = await ask(request);
        if (decision === "deny") {
          return {
            output: `permission denied: ${request.reason}`,
            isError: true,
          };
        }
        if (decision === "allow-always") {
          rules.push({
            tool: request.tool,
            ...(request.subject === undefined ? {} : { pattern: request.subject }),
            action: "allow",
          });
        }
      }

      return tool.run(args, ctx);
    },
  };

  return wrapped;
}

/** What the tool is asking to do. */
export function describeRequest(
  tool: Tool,
  args: unknown,
  ctx: ToolContext,
  workspace: string,
): PermissionRequest {
  const effect = tool.effect ?? "write";
  const record = (args ?? {}) as Record<string, unknown>;

  const rawPath =
    typeof record.path === "string"
      ? record.path
      : typeof record.cwd === "string"
        ? record.cwd
        : undefined;

  const resolved = rawPath === undefined ? undefined : resolvePath(workspace, rawPath);
  const outside =
    resolved !== undefined && !isInside(workspace, resolved);

  const subject =
    effect === "execute"
      ? typeof record.command === "string"
        ? record.command
        : undefined
      : resolved === undefined
        ? typeof record.pattern === "string"
          ? record.pattern
          : undefined
        : relativeTo(workspace, resolved);

  return {
    tool: tool.name,
    effect,
    args,
    ...(subject === undefined ? {} : { subject }),
    ...(resolved === undefined ? {} : { path: resolved }),
    ...(outside ? { outsideWorkspace: true } : {}),
    ...(tool.needsApproval?.(args) === true ? { needsApproval: true } : {}),
    reason: reasonFor(tool, subject, outside),
  };
}

/** The line the user reads when the agent asks. */
function reasonFor(
  tool: Tool,
  subject: string | undefined,
  outside: boolean,
): string {
  if (outside) {
    return `${tool.name} wants to touch something outside the workspace: ${subject ?? "?"}`;
  }
  return `${tool.name} wants to run: ${subject ?? "(no arguments)"}`;
}

/** Is a path inside a directory? */
export function isInside(directory: string, path: string): boolean {
  const relativePath = relative(directory, path);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

/** A path as the rules see it: relative to the workspace. */
export function relativeTo(workspace: string, path: string): string {
  const relativePath = relative(workspace, path).split(sep).join("/");
  return relativePath.length > 0 ? relativePath : path;
}
