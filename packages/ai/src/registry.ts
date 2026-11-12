/**
 * One streaming entry point for every provider.
 *
 * The registry holds providers under short ids (`anthropic`, `codex`,
 * `opencode`, …) and resolves `"provider/model"` refs to them, so the agent
 * loop and the CLI can switch backends by changing one string.
 */

import { lookupModel, modelsForProvider } from "./models.js";
import { stream, type StreamOptions } from "./stream.js";
import type { Event, ModelInfo, Provider } from "./types.js";

/** Why a ref could not be resolved. */
export type RegistryErrorCode = "invalid-ref" | "not-found" | "duplicate";

export class RegistryError extends Error {
  readonly name = "RegistryError";
  readonly code: RegistryErrorCode;

  constructor(message: string, code: RegistryErrorCode) {
    super(message);
    this.code = code;
  }
}

export interface RegisterOptions {
  /** Replace a provider that is already registered under the same id. */
  replace?: boolean;
  /** Extra model metadata for this provider, keyed by model id. */
  models?: Record<string, Partial<ModelInfo>>;
}

/** A ref resolved to a provider and a model. */
export interface ResolvedModel {
  /** Provider id, e.g. `"anthropic"`. */
  providerId: string;
  /** Model id as sent to the provider, e.g. `"claude-opus-5-5"`. */
  model: string;
  /** The registered provider. */
  provider: Provider;
  /** Table metadata for this model, when the table knows it. */
  info?: ModelInfo;
}

/** A request without the model, which the ref supplies. */
export type RegistryStreamRequest = Omit<StreamOptions, "model"> & {
  /** Overrides the model from the ref. */
  model?: string;
};

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();
  private readonly overrides = new Map<
    string,
    Record<string, Partial<ModelInfo>>
  >();

  /**
   * Add a provider. Registering the same id twice is an error unless
   * `replace` is set, so a typo cannot silently shadow a working provider.
   */
  register(provider: Provider, options: RegisterOptions = {}): this {
    const { replace = false, models } = options;

    if (this.providers.has(provider.id) && !replace) {
      throw new RegistryError(
        `registry: "${provider.id}" is already registered — pass { replace: true } to swap it`,
        "duplicate",
      );
    }

    this.providers.set(provider.id, provider);
    if (models !== undefined) {
      this.overrides.set(provider.id, { ...this.overrides.get(provider.id), ...models });
    }
    return this;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  /** Registered provider ids. */
  list(): string[] {
    return [...this.providers.keys()].sort();
  }

  /**
   * Resolve a `"provider/model"` ref.
   *
   * The ref is split on the **first** slash, so router ids that carry the
   * vendor (`"openrouter/anthropic/claude-opus-5-5"`) keep their full model
   * id.
   */
  resolve(ref: string): ResolvedModel {
    const trimmed = ref.trim();
    const slash = trimmed.indexOf("/");

    if (slash <= 0 || slash === trimmed.length - 1) {
      throw new RegistryError(
        `registry: "${ref}" is not a "provider/model" ref`,
        "invalid-ref",
      );
    }

    const providerId = trimmed.slice(0, slash);
    const model = trimmed.slice(slash + 1);

    const provider = this.providers.get(providerId);
    if (provider === undefined) {
      const known = this.list();
      throw new RegistryError(
        `registry: no provider "${providerId}"${
          known.length > 0 ? ` — registered: ${known.join(", ")}` : ""
        }`,
        "not-found",
      );
    }

    const info = this.model(trimmed);
    return {
      providerId,
      model,
      provider,
      ...(info === undefined ? {} : { info }),
    };
  }

  /**
   * Table metadata for a ref, merged with the provider's own overrides.
   * Synchronous: it never calls the provider's `/models` endpoint.
   */
  model(ref: string): ModelInfo | undefined {
    const trimmed = ref.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0) return undefined;

    const providerId = trimmed.slice(0, slash);
    const model = trimmed.slice(slash + 1);

    const base = lookupModel(providerId, model);
    const override = this.overrides.get(providerId)?.[model];

    if (base === undefined && override === undefined) return undefined;
    return { ...base, ...override, id: model, provider: providerId };
  }

  /**
   * Every model the registry can serve: what the providers report, plus what
   * the table knows.
   *
   * A provider whose `/models` call fails does not sink the whole list — the
   * table entries are still returned.
   */
  async models(): Promise<ModelInfo[]> {
    const merged = new Map<string, ModelInfo>();

    for (const [providerId, provider] of this.providers) {
      for (const info of modelsForProvider(providerId)) {
        merged.set(`${providerId}/${info.id}`, {
          ...info,
          ...this.overrides.get(providerId)?.[info.id],
          id: info.id,
          provider: providerId,
        });
      }

      let reported: ModelInfo[] = [];
      try {
        reported = await provider.models();
      } catch {
        // The provider is unreachable or has no model endpoint (Codex); the
        // table entries above are still useful.
        continue;
      }

      for (const info of reported) {
        const key = `${providerId}/${info.id}`;
        merged.set(key, {
          ...merged.get(key),
          ...info,
          id: info.id,
          provider: providerId,
        });
      }
    }

    return [...merged.values()].sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );
  }

  /** Stream a response for a `"provider/model"` ref. */
  stream(ref: string, request: RegistryStreamRequest = {}): AsyncIterable<Event> {
    const resolved = this.resolve(ref);
    return stream(resolved.provider, {
      ...request,
      model: request.model ?? resolved.model,
    });
  }
}
