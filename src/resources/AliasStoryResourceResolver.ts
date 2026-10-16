import { HostStoryResourceResolver } from "./HostStoryResourceResolver.js";
import type { StoryResourceResolver } from "./StoryResourcePort.js";

/** Exact host-owned aliases, captured once for this player's resource scope. */
export class AliasStoryResourceResolver extends HostStoryResourceResolver {
  constructor(host: StoryResourceResolver, aliases: Iterable<readonly [string, string]>) {
    const sources = new Map<string, string>();
    for (const [alias, source] of aliases) {
      if (!alias || !source) throw new TypeError("Resource aliases require non-empty sources");
      const previous = sources.get(alias);
      if (previous !== undefined && previous !== source) {
        throw new TypeError(`Conflicting resource alias: ${alias}`);
      }
      sources.set(alias, source);
    }
    const resolve = (source: string): string => sources.get(source) ?? source;
    super({
      canLoad: (source) => host.canLoad(resolve(source)),
      load: (source, signal) => host.load(resolve(source), signal),
      ...(host.loadSharedBytes
        ? { loadSharedBytes: (source: string, signal?: AbortSignal) => host.loadSharedBytes!(resolve(source), signal) }
        : {}),
      retain: (source, signal) => host.retain(resolve(source), signal),
      resolveRenderable: (source, signal) => host.resolveRenderable(resolve(source), signal),
    });
  }
}
