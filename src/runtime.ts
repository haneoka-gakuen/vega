export interface StoryChatIconSprites {
  readonly signal?: string;
  readonly rss?: string;
  readonly alarm?: string;
  readonly navi?: string;
  readonly back?: string;
  readonly bars?: string;
  readonly call?: string;
  readonly batteryFrame?: string;
}

/**
 * An optional host-owned trust/cache boundary for already-resolved story
 * resources. Loading remains the responsibility of Vega resource
 * contributions; the scope only identifies and validates one coherent source.
 */
export interface StoryResourceScope {
  readonly id: string;
  contains(url: string): boolean;
}

export interface StoryRuntimeAdapters {
  validateResourceUrl(value: unknown, label?: string): string;
  localize(value: unknown): string;
  resolveLocalized?(value: unknown): StoryResolvedText | null | undefined;
  message(key: StoryMessageKey): string;
  /** Optional host-owned chat icon sprites. Missing entries use Vega defaults. */
  chatIconSprites?: Readonly<StoryChatIconSprites>;
}

export interface StoryResolvedText {
  text: string;
  lang?: string;
}

export type StoryMessageKey =
  | "settings"
  | "volume"
  | "autoplay"
  | "instantText"
  | "bgm"
  | "textSize"
  | "fullscreen"
  | "loading"
  | "play"
  | "replay"
  | "skipVideo"
  | "notAvailable";

const DEFAULT_MESSAGES: Record<StoryMessageKey, string> = {
  settings: "Settings",
  volume: "Volume",
  autoplay: "Auto play",
  instantText: "Instant text",
  bgm: "BGM",
  textSize: "Text size",
  fullscreen: "Fullscreen",
  loading: "Loading",
  play: "Play",
  replay: "Replay",
  skipVideo: "Skip video",
  notAvailable: "Not available",
};

export function isCanonicalStoryResourceUrl(value: unknown): boolean {
  try {
    adapters.validateResourceUrl(value);
    return Boolean(String(value || ""));
  } catch {
    return false;
  }
}

export function requireCanonicalStoryResourceUrl(
  value: unknown,
  label = "resource",
): string {
  return adapters.validateResourceUrl(value, label);
}

export function requireScopedStoryResourceUrl(
  value: unknown,
  label = "resource",
  scope?: Readonly<StoryResourceScope>,
): string {
  const url = requireCanonicalStoryResourceUrl(value, label);
  if (!url || !scope) return url;
  const scopeId = String(scope.id || "").trim();
  if (!scopeId) throw new TypeError("Story resource scope id cannot be empty");
  if (scope.contains(url)) return url;
  throw new TypeError(
    `Story ${label} URL is outside resource scope ${scopeId}: ${url}`,
  );
}

function defaultValidateResourceUrl(
  value: unknown,
  label = "resource",
): string {
  const url = String(value || "");
  if (!url) return "";
  if (/^(?:data:|blob:|https?:\/\/)/i.test(url)) return url;
  if (url.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(url)) {
    throw new TypeError(`Story ${label} URL is unsafe: ${url}`);
  }
  const pathname = url.split(/[?#]/, 1)[0] || "";
  if (
    pathname.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError(`Story ${label} URL contains path traversal: ${url}`);
  }
  return url;
}

function defaultLocalize(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(defaultLocalize).find(Boolean) || "";
  }
  if (value && typeof value === "object") {
    const entries = Object.values(value as Record<string, unknown>);
    return entries.map(defaultLocalize).find(Boolean) || "";
  }
  return value == null ? "" : String(value);
}

const defaults: StoryRuntimeAdapters = {
  validateResourceUrl: defaultValidateResourceUrl,
  localize: defaultLocalize,
  message: (key) => DEFAULT_MESSAGES[key],
};

let adapters: StoryRuntimeAdapters = { ...defaults };

export function configureStoryRuntime(
  next: Partial<StoryRuntimeAdapters>,
): void {
  adapters = { ...adapters, ...next };
}

export function resetStoryRuntimeConfiguration(): void {
  adapters = { ...defaults };
}

export function storyRuntime(): Readonly<StoryRuntimeAdapters> {
  return adapters;
}

export function resolveStoryLocalizedText(value: unknown): StoryResolvedText {
  const resolved = adapters.resolveLocalized?.(value);
  if (resolved && typeof resolved.text === "string") {
    return resolved.lang
      ? { text: resolved.text, lang: resolved.lang }
      : { text: resolved.text };
  }
  return { text: adapters.localize(value) };
}
