/**
 * The session the CLI works in.
 *
 * A provider from the ref, the tools behind the permissions, and the state
 * the loop keeps — with the conversation written down as it happens, so it can
 * be picked up again later.
 */

import {
  AuthError,
  createProvider,
  missingProvider,
  ProviderError,
  type Provider,
  type ProviderFactoryOptions,
} from "@cli-agent/ai";
import {
  createTools,
  withPermissions,
  PermissionController,
  type AskPermission,
  type PermissionRule,
  type Tool,
} from "@cli-agent/tools";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CheckpointStore,
  buildContext,
  createState,
  createSkillTool,
  findSkills,
  findCommands,
  HookRunner,
  loadExtensions,
  Log,
  type LoadedExtensions,
  loadRoles,
  readHooksConfig,
  SessionStore,
  Board,
  boardPath,
  createTaskTool,
  type AgentState,
  type AgentRole,
  type Command,
  type Skill,
  type WorkerRecord,
  WorkerManager,
} from "@cli-agent/core";
import { loadMcpTools, readMcpConfig, type McpTools } from "@cli-agent/tools";
import { SessionController } from "./session-controller.js";

export interface SessionOptions {
  restoreModel?: boolean;
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
  /**
   * The providers of this session, by id.
   *
   * They are built once and kept: a provider that owns a process — the
   * OpenCode CLI drives one — would otherwise start a new one every time it
   * is asked for.
   */
  providers?: Map<string, Provider>;
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
  /** The skills that are available. */
  skills?: Skill[];
  /** The tools of the MCP servers, when they are already connected. */
  mcp?: McpTools;
  /** The hooks, when they are already set up. */
  hooks?: HookRunner;
  /** The commands the user has of their own. */
  commands?: Command[];
  /** The extensions, when they are already loaded. */
  extensions?: LoadedExtensions;
  /** Where the log is written, when it is not the default. */
  log?: string;
  /** Write no log at all. */
  noLog?: boolean;
}

export interface Session {
  permissions: PermissionController;
  workerManager: WorkerManager;
  controller: SessionController;
  /** The provider. */
  provider: Provider;
  /** The providers of this session, by id. */
  providers: Map<string, Provider>;
  /**
   * The provider behind a "provider/model" ref.
   *
   * It is built once and kept, so a provider that owns a process does not
   * start a new one for every turn.
   */
  providerFor(ref: string): Promise<Provider>;
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
  /** The skills that are available. */
  skills: Skill[];
  /** The MCP servers that answered, and the ones that did not. */
  mcp: McpTools;
  /** The commands the user has of their own. */
  commands: Command[];
  /** What the extensions added. */
  extensions: LoadedExtensions;
  /**
   * The workers that have run, and what they did.
   *
   * The user may look inside one of them.
   */
  workers: Map<string, WorkerRecord>;
  /**
   * What is missing, when something is.
   *
   * The session opens even when there are no credentials: the user may be
   * signing in, or looking at what the agent can do. The first request
   * says what is missing.
   */
  missing?: { provider: string; message: string };
  /**
   * Shut the session down.
   *
   * The MCP servers are processes of their own: they have to be stopped,
   * or the agent never finishes.
   */
  close(): Promise<void>;
}

/** The provider id of a "provider/model" ref. */
export function providerIdOf(ref: string): string {
  const slash = ref.indexOf("/");
  return slash <= 0 ? ref : ref.slice(0, slash);
}

/**
 * Is this "there is no credential" or "there is no such provider"?
 *
 * Both are things the user can fix from the session: the first with a
 * key, the second with a different name.
 */
function isMissingProvider(error: unknown): boolean {
  if (error instanceof AuthError) return error.code === "config";
  if (error instanceof ProviderError) return error.code === "protocol";
  return false;
}

/** The model id of a "provider/model" ref. */
export function modelIdOf(ref: string): string {
  const slash = ref.indexOf("/");
  return slash <= 0 ? ref : ref.slice(slash + 1);
}

/**
 * Open the log of a session.
 *
 * The log goes beside the sessions, in the user's own directory, unless
 * the command line says where it should go.
 */
async function openLog(
  options: SessionOptions,
  sessionId: string | undefined,
): Promise<Log | undefined> {
  if (options.noLog === true) return undefined;

  const path =
    options.log ??
    join(homedir(), ".myagent", "logs", `${sessionId ?? "session"}.jsonl`);

  try {
    await mkdir(dirname(path), { recursive: true });
  } catch {
    return undefined;
  }

  return new Log({ path });
}

/** Build the session. */
export async function createSession(options: SessionOptions): Promise<Session> {
  const providerId = providerIdOf(options.model);
  const model = modelIdOf(options.model);

  // The extensions of the project: the tools, commands and providers they
  // add.
  const extensions =
    options.extensions ?? (await loadExtensions({ cwd: options.cwd }));

  // The factory knows the providers an extension added, so a model may be
  // served by one.
  const factory: ProviderFactoryOptions = {
    ...(options.factory ?? {}),
    providers: extensions.providers,
  };

  // One provider per id, for the whole session: a provider that owns a
  // process is asked for it once.
  const providers = options.providers ?? new Map<string, Provider>();
  const providerFor = async (ref: string): Promise<Provider> => {
    const id = providerIdOf(ref);
    const existing = providers.get(id);
    if (existing !== undefined) return existing;
    const made = await createProvider(id, factory);
    providers.set(id, made);
    // A provider that owns a process starts it now, so that the wait is
    // over by the time the first question is asked.
    made.warm?.();
    return made;
  };

  // The provider. When there is no credential the session still opens:
  // the first request says what is missing.
  let provider = options.provider;
  let missing: { provider: string; message: string } | undefined;

  if (provider === undefined) {
    try {
      provider = await providerFor(options.model);
    } catch (error) {
      // A missing credential, or a provider nobody knows: neither is a
      // reason to close the door. The session opens and says what is
      // missing, so the user can sign in and carry on.
      if (!isMissingProvider(error)) throw error;
      missing = {
        provider: providerId,
        message: error instanceof Error ? error.message : String(error),
      };
      provider = missingProvider(providerId, missing.message);
    }
  } else {
    providers.set(providerId, provider);
    // The provider was handed to us: it is warmed here too, so a provider
    // that owns a process is ready before the first question.
    provider.warm?.();
  }

  // The tools of the MCP servers, if there are any.
  const mcp =
    options.mcp ?? (await loadMcpTools(await readMcpConfig(options.cwd)));

  // Everything the model may call, behind the permissions: our own tools,
  // the tools of the extensions and the tools of the MCP servers. A tool
  // nobody knows is treated as one that changes things, which is the
  // careful answer.
  const permissions = new PermissionController(
    {
      mode: options.permissionMode,
      rules: options.rules ?? [],
      workspace: options.cwd,
    },
    options.ask,
  );
  const tools = withPermissions(
    [...createTools(), ...extensions.tools, ...mcp.tools],
    {
      mode: options.permissionMode,
      controller: permissions,
      rules: options.rules ?? [],
      workspace: options.cwd,
      ...(options.ask === undefined ? {} : { ask: options.ask }),
    },
  );

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
    sessionId = await store.create({ model: options.model });
  }

  const messages = await store.transcript(sessionId);

  // The roles the agents can be, and the board they write to.
  const roles = options.roles ?? (await loadRoles({ cwd: options.cwd }));
  const board = options.board ?? new Board({ path: boardPath(options.cwd) });
  await board.load();

  // The task tool: how the agent delegates.
  const workers = new Map<string, WorkerRecord>();
  const workerManager = new WorkerManager({
    parentId: store.id,
    roles,
    providerFor,
    defaultModel: options.model,
    tools,
    cwd: options.cwd,
    board,
    onWorker: (worker) => workers.set(worker.id, worker),
    ...(options.workerTokenBudget === undefined
      ? {}
      : { tokenBudget: options.workerTokenBudget }),
    ...(options.workerCostBudget === undefined
      ? {}
      : { costBudget: options.workerCostBudget }),
  });
  const task = createTaskTool({
    ...workerManager.options,
    manager: workerManager,
  });

  // The skills: only their names and descriptions go into the prompt, and
  // the body is loaded when the model asks for it.
  const skills = options.skills ?? (await findSkills(options.cwd));
  const skill = createSkillTool({ cwd: options.cwd, skills });

  // The hooks: the shell commands that run when things happen.
  const hooks =
    options.hooks ??
    new HookRunner(await readHooksConfig(options.cwd), { cwd: options.cwd });

  // The commands the user has of their own: the files in the folder, and
  // the ones the extensions added.
  const commands = [
    ...(options.commands ?? (await findCommands(options.cwd))),
    ...extensions.commands,
  ];

  // The log: everything that happens, one JSON object per line.
  const log = await openLog(options, sessionId);

  const state = createState(provider, {
    model,
    tools: [
      ...tools,
      ...withPermissions([task, skill], {
        mode: permissions.mode,
        controller: permissions,
        workspace: options.cwd,
      }),
    ],
    messages,
    cwd: options.cwd,
    journal: store,
    checkpoints: new CheckpointStore(),
    active: { skills },
    hooks,
    log,
  });

  const controller = new SessionController({
    state,
    store,
    permissions,
    workerManager,
    model: options.model,
    providerFor,
    onSwitch: async (id) => {
      state.log = await openLog(options, id);
    },
  });

  // The context is built before the first question, and the map of the
  // project is the slow part of it: it reads every file of the project.
  // It is built now, while the user is still typing, so that the first
  // question does not wait for it.
  void buildContext(state).catch(() => undefined);

  if (
    options.restoreModel !== false &&
    (options.continueLast || options.resume)
  ) {
    const saved = await store.metadata();
    if (saved?.model) {
      const ref = saved.model.includes("/")
        ? saved.model
        : `${providerId}/${saved.model}`;
      try {
        await controller.setModel(
          ref,
          ref === options.model ? provider : undefined,
          state.reasoningEffort,
        );
      } catch (error) {
        missing = {
          provider: providerIdOf(ref),
          message: `Saved model unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
        await controller.setModel(
          ref,
          missingProvider(providerIdOf(ref), missing.message),
        );
      }
    }
  }

  await controller.restore();

  return {
    permissions,
    workerManager,
    controller,
    get provider() {
      return state.provider;
    },
    providers,
    providerFor,
    tools: state.tools,
    state,
    store,
    get sessionId() {
      return store.id;
    },
    roles,
    board,
    skills,
    mcp,
    commands,
    extensions,
    workers: workerManager.records,
    ...(missing === undefined ? {} : { missing }),
    async close() {
      await workerManager.stopAll();
      await controller.save();
      // The servers are processes: they have to be stopped, or the agent
      // never finishes.
      await Promise.all(
        mcp.servers.map((server) => server.close().catch(() => undefined)),
      );
      // The providers of this session go last: one of them may own a
      // process of its own.
      for (const made of providers.values()) {
        await made.close?.().catch(() => undefined);
      }
    },
  };
}
