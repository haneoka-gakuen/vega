import type { AdvPlayer } from "../core/AdvPlayer";
import type { AdvPlayerState } from "../types/AdvRuntime";
import type { VegaLifetime } from "./lifecycle";
import type {
  VegaDisposable,
  VegaServiceKey,
  VegaThemeContribution,
  VegaUiSlotContribution,
  VegaUiSlotContext,
} from "./plugins";

export const VEGA_STANDARD_UI_SLOTS = ["before-stage", "stage-overlay", "dialogue", "controls", "after-stage"] as const;

export type VegaStandardUiSlot = (typeof VEGA_STANDARD_UI_SLOTS)[number];

export interface VegaPlayerPresentation {
  readonly root: HTMLElement;
  readonly stage: HTMLElement;
  readonly slots: ReadonlyMap<string, HTMLElement>;
  readonly themeId?: string;
  /** Selected contribution, used for story-resource preparation. */
  readonly theme?: VegaThemeContribution;
}

export interface VegaPlayerPresentationOptions {
  readonly engineId: string;
  readonly playerId: string;
  readonly mount: HTMLElement;
  readonly lifetime: VegaLifetime;
  readonly themes: readonly VegaThemeContribution[];
  readonly theme?: string | false;
  readonly uiSlots: readonly VegaUiSlotContribution[];
}

export const isVegaUiSlotEventTarget = (target: EventTarget | null): boolean => {
  const candidate = target as {
    closest?: (selector: string) => Element | null;
  } | null;
  return typeof candidate?.closest === "function" && candidate.closest("[data-vega-ui-slot]") !== null;
};

type SharedThemeStyle =
  | {
      readonly kind: "sheet";
      readonly sheet: CSSStyleSheet;
      references: number;
    }
  | {
      readonly kind: "element";
      readonly element: HTMLStyleElement;
      references: number;
    };

const themeStyles = new WeakMap<Document, Map<string, SharedThemeStyle>>();

export const createVegaPlayerPresentation = (options: VegaPlayerPresentationOptions): VegaPlayerPresentation => {
  const document = options.mount.ownerDocument;
  if (!document?.createElement || typeof options.mount.append !== "function") {
    if (options.themes.length || options.uiSlots.length) {
      throw new TypeError("Vega theme and UI-slot plugins require a DOM HTMLElement mount");
    }
    return { root: options.mount, stage: options.mount, slots: new Map() };
  }

  const root = document.createElement("div");
  root.className = "vega-player";
  root.dataset.vegaEngine = options.engineId;
  root.dataset.vegaPlayer = options.playerId;
  root.style.cssText = "position:absolute;inset:0;overflow:hidden;isolation:isolate;container-type:size;";

  const beforeStage = createSlot(document, "before-stage", -10);
  const stage = document.createElement("div");
  stage.className = "vega-player__stage";
  stage.dataset.vegaStageHost = "";
  stage.style.cssText = "position:absolute;inset:0;z-index:0;";
  const stageOverlay = createSlot(document, "stage-overlay", 20);
  const dialogue = createSlot(document, "dialogue", 30);
  const controls = createSlot(document, "controls", 40);
  const afterStage = createSlot(document, "after-stage", 50);
  root.append(beforeStage, stage, stageOverlay, dialogue, controls, afterStage);
  options.mount.append(root);
  options.lifetime.defer(() => root.remove());

  const slots = new Map<string, HTMLElement>([
    ["before-stage", beforeStage],
    ["stage-overlay", stageOverlay],
    ["dialogue", dialogue],
    ["controls", controls],
    ["after-stage", afterStage],
  ]);
  const customNames = new Set(
    options.uiSlots
      .map(({ slot }) => slot)
      .filter((slot) => !slots.has(slot))
      .sort(),
  );
  for (const name of customNames) {
    const host = createSlot(document, name, 50);
    root.append(host);
    slots.set(name, host);
  }

  const theme = selectTheme(options.themes, options.theme);
  if (theme) {
    root.dataset.vegaTheme = theme.id;
    applyThemeTokens(root, theme.tokens);
    if (theme.cssText?.trim()) options.lifetime.defer(acquireThemeStyle(document, theme));
  }
  return {
    root,
    stage,
    slots,
    ...(theme ? { themeId: theme.id, theme } : {}),
  };
};

export const mountVegaUiSlots = async (options: {
  readonly resources?: VegaUiSlotContext["resources"];
  readonly contributions: readonly VegaUiSlotContribution[];
  readonly presentation: VegaPlayerPresentation;
  readonly lifetime: VegaLifetime;
  readonly engineId: string;
  readonly playerId: string;
  readonly player: AdvPlayer;
  readonly state: AdvPlayerState;
  readonly service: <T>(key: VegaServiceKey<T>) => T | undefined;
}): Promise<void> => {
  for (const contribution of resolveVegaUiSlotContributions(options.contributions)) {
    if (options.lifetime.signal.aborted) throw options.lifetime.signal.reason;
    const host = options.presentation.slots.get(contribution.slot);
    if (!host) throw new ReferenceError(`Vega UI slot host does not exist: ${contribution.slot}`);
    const context: VegaUiSlotContext = {
      ...(options.resources ? { resources: options.resources } : {}),
      engineId: options.engineId,
      playerId: options.playerId,
      player: options.player,
      state: options.state,
      root: options.presentation.root,
      signal: options.lifetime.signal,
      services: options.service,
    };
    const disposable = await contribution.mount(host, context);
    assertDisposable(contribution.id, disposable);
    options.lifetime.use(disposable);
  }
};

export const resolveVegaUiSlotContributions = (
  contributions: readonly VegaUiSlotContribution[],
): readonly VegaUiSlotContribution[] => {
  const resolved: VegaUiSlotContribution[] = [];
  for (const contribution of contributions) {
    if (contribution.replace) {
      for (let index = resolved.length - 1; index >= 0; index -= 1) {
        if (resolved[index]?.slot === contribution.slot) resolved.splice(index, 1);
      }
    }
    resolved.push(contribution);
  }
  return resolved;
};

const createSlot = (document: Document, name: string, zIndex: number): HTMLDivElement => {
  const slot = document.createElement("div");
  slot.className = `vega-ui-slot vega-ui-slot--${cssIdentifier(name)}`;
  slot.dataset.vegaUiSlot = name;
  slot.style.cssText = `position:absolute;inset:0;z-index:${zIndex};pointer-events:none;`;
  return slot;
};

const selectTheme = (
  themes: readonly VegaThemeContribution[],
  selector: string | false | undefined,
): VegaThemeContribution | undefined => {
  if (selector === false || !themes.length) return undefined;
  if (selector) {
    const selected = themes.find(({ id }) => id === selector);
    if (!selected) throw new ReferenceError(`Vega theme is not installed: ${selector}`);
    return selected;
  }
  const defaults = themes.filter((theme) => theme.default);
  if (defaults.length > 1) {
    throw new Error(`Multiple default Vega themes are installed: ${defaults.map(({ id }) => id).join(", ")}`);
  }
  if (defaults.length === 1) return defaults[0];
  if (themes.length === 1) return themes[0];
  throw new Error(`Multiple Vega themes are installed; select one with VegaPlayerOptions.theme`);
};

const applyThemeTokens = (root: HTMLElement, tokens: Readonly<Record<string, string | number>> | undefined): void => {
  for (const [name, value] of Object.entries(tokens ?? {})) {
    const property = name.startsWith("--") ? name : `--vega-${kebabCase(name)}`;
    if (!/^--[a-zA-Z0-9_-]+$/u.test(property)) {
      throw new TypeError(`Invalid Vega theme token: ${name}`);
    }
    root.style.setProperty(property, String(value));
  }
};

const acquireThemeStyle = (document: Document, theme: VegaThemeContribution): (() => void) => {
  const cssText = theme.cssText?.trim() ?? "";
  const key = `${theme.id}\u0000${cssText}`;
  const registry = themeStyles.get(document) ?? new Map<string, SharedThemeStyle>();
  themeStyles.set(document, registry);
  const existing = registry.get(key);
  if (existing) {
    existing.references += 1;
    return releaseThemeStyle(document, key);
  }
  const sheet = adoptThemeStyleSheet(document, cssText);
  if (sheet) {
    registry.set(key, { kind: "sheet", sheet, references: 1 });
    return releaseThemeStyle(document, key);
  }
  const element = document.createElement("style");
  element.dataset.vegaThemeStyle = theme.id;
  element.textContent = cssText;
  (document.head ?? document.documentElement).append(element);
  registry.set(key, { kind: "element", element, references: 1 });
  return releaseThemeStyle(document, key);
};

type CSSStyleSheetConstructor = new () => CSSStyleSheet;

const adoptThemeStyleSheet = (document: Document, cssText: string): CSSStyleSheet | undefined => {
  try {
    const realm = document.defaultView as (Window & { CSSStyleSheet?: CSSStyleSheetConstructor }) | null;
    const constructor =
      realm?.CSSStyleSheet ?? (typeof globalThis.CSSStyleSheet === "function" ? globalThis.CSSStyleSheet : undefined);
    if (!constructor) return undefined;
    const sheet = new constructor();
    if (typeof sheet.replaceSync !== "function") return undefined;
    sheet.replaceSync(cssText);
    const adopted = Array.from(document.adoptedStyleSheets);
    document.adoptedStyleSheets = adopted.includes(sheet) ? adopted : [...adopted, sheet];
    return sheet;
  } catch {
    return undefined;
  }
};

const removeAdoptedThemeStyleSheet = (document: Document, sheet: CSSStyleSheet): void => {
  try {
    const adopted = Array.from(document.adoptedStyleSheets);
    if (!adopted.includes(sheet)) return;
    document.adoptedStyleSheets = adopted.filter((candidate) => candidate !== sheet);
  } catch {
    // The document may already be detached or its stylesheet realm disposed.
  }
};

const releaseThemeStyle = (document: Document, key: string): (() => void) => {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const registry = themeStyles.get(document);
    const shared = registry?.get(key);
    if (!shared) return;
    shared.references -= 1;
    if (shared.references > 0) return;
    if (shared.kind === "sheet") removeAdoptedThemeStyleSheet(document, shared.sheet);
    else shared.element.remove();
    registry?.delete(key);
    if (!registry?.size) themeStyles.delete(document);
  };
};

const assertDisposable = (id: string, value: VegaDisposable): void => {
  if (typeof value === "function") return;
  if (
    value &&
    typeof value === "object" &&
    ["dispose", "destroy", "close"].some((method) => typeof (value as Record<string, unknown>)[method] === "function")
  ) {
    return;
  }
  throw new TypeError(`Vega UI contribution ${id} did not return a disposable`);
};

const cssIdentifier = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "custom";

const kebabCase = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/[^a-zA-Z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
