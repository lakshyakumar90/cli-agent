/**
 * The "provider/model" ref.
 *
 * The ref is how a model is named in the command line and in the
 * configuration: "provider/model". The provider is built from the part
 * before the slash, and the model is called by the part after it.
 *
 * The router ids carry the vendor inside them - "openrouter/anthropic/
 * claude-opus-5-5" is one model called "anthropic/claude-opus-5-5" - so
 * the ref is split on the FIRST slash only.
 */

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
