import type { StoryResourceResolver } from "../rendering/StorySceneBackend";

export interface StoryResourceAdapter {
  readonly schemes: readonly string[];
  load(url: URL, signal: AbortSignal): Promise<Uint8Array>;
}

const normalizeScheme = (value: string): string => value.trim().toLowerCase().replace(/:$/, "");

const asUrl = (source: string): URL => {
  const base =
    typeof document !== "undefined" && document.baseURI
      ? document.baseURI
      : typeof location !== "undefined"
        ? location.href
        : "https://vega.invalid/";
  return new URL(source, base);
};

const abortError = (source: string): Error => {
  const error = new Error(`Loading was aborted: ${source}`);
  error.name = "AbortError";
  return error;
};

const contentTypeFor = (source: string): string => {
  const pathname = source.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".avif")) return "image/avif";
  if (pathname.endsWith(".mp4")) return "video/mp4";
  if (pathname.endsWith(".webm")) return "video/webm";
  if (pathname.endsWith(".ogg") || pathname.endsWith(".opus")) return "audio/ogg";
  if (pathname.endsWith(".mp3")) return "audio/mpeg";
  return "application/octet-stream";
};

export class DefaultStoryResourceResolver implements StoryResourceResolver {
  private readonly adapters: readonly StoryResourceAdapter[];

  constructor(adapters: readonly StoryResourceAdapter[] = []) {
    this.adapters = [...adapters];
  }

  canLoad(source: string): boolean {
    if (!source) return false;
    const url = asUrl(source);
    if (this.adapterFor(url)) return true;
    return ["http:", "https:", "data:", "blob:", "file:"].includes(url.protocol);
  }

  async load(source: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) throw abortError(source);
    const url = asUrl(source);
    const adapter = this.adapterFor(url);
    if (adapter) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        return await adapter.load(url, controller.signal);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    }
    const response = await fetch(source, { signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${source}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async resolveRenderable(
    source: string,
    signal?: AbortSignal,
  ): Promise<{ readonly url: string; readonly release: () => void }> {
    const url = asUrl(source);
    if (!this.adapterFor(url)) return { url: source, release: () => undefined };
    const bytes = await this.load(source, signal);
    const payload = Uint8Array.from(bytes);
    const objectUrl = URL.createObjectURL(new Blob([payload.buffer], { type: contentTypeFor(source) }));
    let released = false;
    return {
      url: objectUrl,
      release: () => {
        if (released) return;
        released = true;
        URL.revokeObjectURL(objectUrl);
      },
    };
  }

  private adapterFor(url: URL): StoryResourceAdapter | undefined {
    const scheme = normalizeScheme(url.protocol);
    return this.adapters.find((adapter) => adapter.schemes.some((candidate) => normalizeScheme(candidate) === scheme));
  }
}
