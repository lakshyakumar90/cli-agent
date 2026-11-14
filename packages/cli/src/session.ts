/**
 * The session the CLI works in.
 *
 * A provider from the ref, the tools behind the permissions, and the state
 * the loop keeps — with the conversation written down as it happens, so it can
 * be picked up again later.
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
import {
  CheckpointStore,
  createState,
  loadRoles,
  SessionStore,
  Board,
  boardPath,
  createTaskTool,
  type AgentState,
  type AgentRole,
} from "@cli-agent/core";

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
  /** Where the sessions are written. */
  sessionRoot?: string;
  /** Carry on with the last session of this directory. */
  continueLast?: boolean;
  /** Open a session by id. */
  resume?: string;
  /** The roles the agents can be. */
  roles?: Map<string, AgentRole>;
  /** The board the tasks are written to. */
  board?: Board;
  /** The tokens one worker may use. */
  workerTokenBudget?: number;
  /** The US dollars one worker may spend. */
  workerCostBudget?: number;
}

export interface Session {
  /** The provider. */
  provider: Provider;
  /** The tools, behind the permissions. */
  tools: Tool[];
  /** The state the loop keeps. */
  state: AgentState;
  /** Where the conversation is written down. */
  store: SessionStore;
  /** The session that is open. */
  sessionId?: string;
  /** The roles the agents can be. */
  roles: Map<string, AgentRole>;
  /** The board the tasks are written to. */
  board: Board;
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

  const store = new SessionStore({
    cwd: options.cwd,
    ...(options.sessionRoot === undefined ? {} : { root: options.sessionRoot }),
  });

  // Open the session: the one named, the last one, or a new one.
  let sessionId: string | undefined;
  if (options.resume !== undefined && options.resume.length > 0) {
    sessionId = (await store.open({ id: options.resume })) ?? undefined;
  } else if (options.continueLast === true) {
    sessionId = (await store.open()) ?? undefined;
  }
  if (sessionId === undefined) {
    sessionId = await store.create({ model });
  }

  const messages = await store.transcript(sessionId);

  // The roles the agents can be, and the board they write to.
  const roles = options.roles ?? (await loadRoles({ cwd: options.cwd }));
  const board = options.board ?? new Board({ path: boardPath(options.cwd) });
  await board.load();

  // The task tool: how the agent delegates.
  const task = createTaskTool({
    roles,
    providerFor: async (workerModel) =>
      createProvider(providerIdOf(workerModel), options.factory ?? {}),
    defaultModel: options.model,
    tools,
    cwd: options.cwd,
    board,
    ...(options.workerTokenBudget === undefined
      ? {}
      : { tokenBudget: options.workerTokenBudget }),
    ...(options.workerCostBudget === undefined
      ? {}
      : { costBudget: options.workerCostBudget }),
  });

  const state = createState(provider, {
    model,
    tools: [...tools, task],
    messages,
    cwd: options.cwd,
    journal: store,
    checkpoints: new CheckpointStore(),
  });

  return { provider, tools: state.tools, state, store, sessionId, roles, board };
}
