/**
 * The session the modes share.
 *
 * A provider from the ref, the tools behind the permissions, and the state
 * the loop keeps.
 */

import {
  createProvider,
  type Provider,
  type ProviderFactoryOptions,
} from "@cli-agent/ai";
import {
  createTools,
  withPermissions,
  type AskPermission,
  type PermissionRule,
  type Tool,
} from "@cli-agent/tools";
import { createState, type AgentState } from "@cli-agent/core";

export interface SessionOptions {
  /** The "provider/model" ref. */
  model: string;
  /** The directory the agent works in. */
  cwd: string;
  /** How much the agent may do without asking. */
  permissionMode: "ask" | "auto-edit" | "yolo" | "plan";
  /** The rules, most specific first. */
  rules?: PermissionRule[];
  /** Asked when a call needs permission. */
  ask?: AskPermission;
  /** The provider, when it is already built (tests). */
  provider?: Provider;
  /** Where the credentials come from. */
  factory?: ProviderFactoryOptions;
}

/** The provider id of a "provider/model" ref. */
export function providerIdOf(ref: string): string {
  const slash = ref.indexOf("/");
  return slash <= 0 ? ref : ref.slice(0, slash);
}

/** The model id of a "provider/model" ref. */
export function modelIdOf(ref: string): string {
  const slash = ref.indexOf("/");
  return slash <= 0 ? ref : ref.slice(slash + 1);
}

export interface Session {
  /** The provider. */
  provider: Provider;
  /** The tools, behind the permissions. */
  tools: Tool[];
  /** The state the loop keeps. */
  state: AgentState;
}

/** Build the session. */
export async function createSession(
  options: SessionOptions,
): Promise<Session> {
  const providerId = providerIdOf(options.model);
  const model = modelIdOf(options.model);

  const provider =
    options.provider ??
    (await createProvider(providerId, options.factory ?? {}));

  const tools = withPermissions(createTools(), {
    mode: options.permissionMode,
    rules: options.rules ?? [],
    workspace: options.cwd,
    ...(options.ask === undefined ? {} : { ask: options.ask }),
  });

  const state = createState(provider, {
    model,
    tools,
    cwd: options.cwd,
  });

  return { provider, tools, state };
}
