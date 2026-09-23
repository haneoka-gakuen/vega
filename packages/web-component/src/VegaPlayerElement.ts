import {
  createVega,
  type AdvPlayerState,
  type AdvStory,
  type VegaEngine,
  type VegaEngineOptions,
  type VegaPlayerHandle,
  type VegaPlayerOptions,
  type VegaPlayerShellOptions,
  vegaProjectToAdvStory,
} from "@haneoka/vega/engine";
import { prepareStoryAudio } from "@haneoka/vega/audio";
import type { VegaProject } from "@haneoka/vega-protocol";

export type VegaPlayerElementAppearance = "light" | "system" | "dark";

export interface VegaPlayerElementReadyDetail {
  readonly element: VegaPlayerElement;
  readonly handle: VegaPlayerHandle;
}

export interface VegaPlayerElementErrorDetail {
  readonly element: VegaPlayerElement;
  readonly error: unknown;
}

type PlayerOptions = Omit<VegaPlayerOptions, "mount" | "shell" | "story" | "theme">;

const HTMLElementBase: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

const template = `
  <section aria-label="Vega visual novel player" part="shell">
    <div part="stage"></div>
    <div hidden part="error" role="alert"></div>
  </section>
`;

const styleSheetText = `
  :host {
    color-scheme: light dark;
    contain: layout paint style;
    display: block;
    min-block-size: 26.25rem;
    overflow: hidden;
    position: relative;
  }
  :host([appearance="light"]) { color-scheme: light; }
  :host([appearance="dark"]) { color-scheme: dark; }
  :host([appearance="system"]) { color-scheme: light dark; }
  [part="shell"], [part="stage"] { inset: 0; position: absolute; }
  [part="error"] {
    background: color-mix(in srgb, Canvas 84%, #b3261e 16%);
    color: CanvasText;
    inset: 12px 12px auto;
    padding: 12px;
    position: absolute;
  }
  [hidden] { display: none !important; }
`;

type CSSStyleSheetConstructor = new () => CSSStyleSheet;
const styleSheets = new WeakMap<Document, CSSStyleSheet>();

const adoptStyleSheet = (shadow: ShadowRoot): void => {
  if (!("adoptedStyleSheets" in shadow)) return;
  const document = shadow.ownerDocument;
  const constructor = document.defaultView?.CSSStyleSheet as CSSStyleSheetConstructor | undefined;
  if (typeof constructor !== "function") return;
  let sheet = styleSheets.get(document);
  if (!sheet) {
    try {
      sheet = new constructor();
      sheet.replaceSync(styleSheetText);
      styleSheets.set(document, sheet);
    } catch {
      return;
    }
  }
  shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
};

const uiSignature = (state: AdvPlayerState): string => JSON.stringify([state.loading, state.error]);

const abortError = (message: string): Error => {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
};

const isAppearance = (value: string | null): value is VegaPlayerElementAppearance =>
  value === "light" || value === "system" || value === "dark";

const sourceBinding = (
  story: AdvStory | null,
  project: VegaProject | null,
  sceneId: string | undefined,
): { readonly story: AdvStory; readonly entryKey?: string } | null => {
  if (project) {
    const compiled = vegaProjectToAdvStory(project, sceneId);
    const entryKey = typeof compiled.vegaEntryKey === "string" ? compiled.vegaEntryKey : undefined;
    return { story: compiled, ...(entryKey ? { entryKey } : {}) };
  }
  return story ? { story } : null;
};

export class VegaPlayerElement extends HTMLElementBase {
  static get observedAttributes(): readonly string[] {
    return ["appearance", "auto-play", "auto-start", "scene-id", "theme"];
  }

  private storyValue: AdvStory | null = null;
  private projectValue: VegaProject | null = null;
  private engineValue: VegaEngine | null = null;
  private engineOptionsValue: VegaEngineOptions | undefined;
  private playerOptionsValue: PlayerOptions | undefined;
  private shellValue: false | VegaPlayerShellOptions | undefined;
  private themeValue: string | false | undefined;
  private autoStartValue = true;
  private activeEngine: VegaEngine | null = null;
  private ownsActiveEngine = false;
  private handleValue: VegaPlayerHandle | null = null;
  private entryKey: string | undefined;
  private started = false;
  private playback: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private generation = 0;
  private connected = false;
  private explicitlyDisposed = false;
  private frame = 0;
  private lastSignature = "";
  private lastReportedStateError = "";
  private errorValue: unknown | null = null;
  private readonly readyWaiters = new Set<{
    readonly resolve: (handle: VegaPlayerHandle) => void;
    readonly reject: (error: unknown) => void;
  }>();
  private stageElement: HTMLDivElement | null = null;
  private errorElement: HTMLDivElement | null = null;
  private readonly prepareAudio = (event: Event): void => prepareStoryAudio(event);

  get story(): AdvStory | null {
    return this.storyValue;
  }

  set story(value: AdvStory | null) {
    if (this.storyValue === value && !this.projectValue) return;
    this.storyValue = value;
    if (value) this.projectValue = null;
    this.requestReload();
  }

  get project(): VegaProject | null {
    return this.projectValue;
  }

  set project(value: VegaProject | null) {
    if (this.projectValue === value && !this.storyValue) return;
    this.projectValue = value;
    if (value) this.storyValue = null;
    this.requestReload();
  }

  get engine(): VegaEngine | null {
    return this.engineValue;
  }

  set engine(value: VegaEngine | null) {
    if (this.engineValue === value) return;
    this.engineValue = value;
    this.requestReload();
  }

  get engineOptions(): VegaEngineOptions | undefined {
    return this.engineOptionsValue;
  }

  set engineOptions(value: VegaEngineOptions | undefined) {
    if (this.engineOptionsValue === value) return;
    this.engineOptionsValue = value;
    if (!this.engineValue) this.requestReload();
  }

  get playerOptions(): PlayerOptions | undefined {
    return this.playerOptionsValue;
  }

  set playerOptions(value: PlayerOptions | undefined) {
    if (this.playerOptionsValue === value) return;
    this.playerOptionsValue = value;
    this.requestReload();
  }

  get shell(): false | VegaPlayerShellOptions | undefined {
    return this.shellValue;
  }

  set shell(value: false | VegaPlayerShellOptions | undefined) {
    if (this.shellValue === value) return;
    this.shellValue = value;
    this.requestReload();
  }

  get handle(): VegaPlayerHandle | null {
    return this.handleValue;
  }

  get error(): unknown | null {
    return this.errorValue;
  }

  get ready(): Promise<VegaPlayerHandle> {
    if (this.handleValue) return Promise.resolve(this.handleValue);
    if (this.explicitlyDisposed) {
      return Promise.reject(new ReferenceError("The Vega player element is disposed"));
    }
    return new Promise<VegaPlayerHandle>((resolve, reject) => {
      this.readyWaiters.add({ resolve, reject });
    });
  }

  get autoPlay(): boolean {
    return this.hasAttribute("auto-play");
  }

  set autoPlay(value: boolean) {
    this.toggleAttribute("auto-play", value);
  }

  get autoStart(): boolean {
    return this.autoStartValue;
  }

  set autoStart(value: boolean) {
    this.setAttribute("auto-start", String(value));
  }

  get appearance(): VegaPlayerElementAppearance {
    const value = this.getAttribute("appearance");
    return isAppearance(value) ? value : "system";
  }

  set appearance(value: VegaPlayerElementAppearance) {
    if (!isAppearance(value)) throw new TypeError(`Unsupported Vega appearance: ${String(value)}`);
    this.setAttribute("appearance", value);
  }

  get theme(): string | false | undefined {
    return this.themeValue;
  }

  set theme(value: string | false | undefined) {
    if (value === undefined) this.removeAttribute("theme");
    else this.setAttribute("theme", value === false ? "false" : value);
  }

  get sceneId(): string | undefined {
    return this.getAttribute("scene-id")?.trim() || undefined;
  }

  set sceneId(value: string | undefined) {
    if (value?.trim()) this.setAttribute("scene-id", value.trim());
    else this.removeAttribute("scene-id");
  }

  connectedCallback(): void {
    this.connected = true;
    this.explicitlyDisposed = false;
    this.addEventListener("pointerdown", this.prepareAudio, true);
    this.addEventListener("keydown", this.prepareAudio, true);
    this.ensureDom();
    if (!this.hasAttribute("appearance")) this.setAttribute("appearance", "system");
    this.requestReload();
  }

  disconnectedCallback(): void {
    this.connected = false;
    this.removeEventListener("pointerdown", this.prepareAudio, true);
    this.removeEventListener("keydown", this.prepareAudio, true);
    this.generation += 1;
    this.rejectReady(abortError("The Vega player element was disconnected"));
    void this.enqueue(() => this.releaseActive()).catch(() => undefined);
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if (name === "auto-play") {
      const player = this.handleValue?.player;
      if (player && player.state.autoPlay !== this.autoPlay) player.toggleAuto();
      return;
    }
    if (name === "auto-start") {
      this.autoStartValue = newValue === null || newValue.toLowerCase() !== "false";
      if (this.autoStartValue && this.handleValue && !this.started) {
        void this.start().catch((error: unknown) => this.reportError(error));
      }
      return;
    }
    if (name === "appearance") {
      if (newValue !== null && !isAppearance(newValue)) {
        this.setAttribute("appearance", "system");
      }
      return;
    }
    if (name === "theme") {
      this.themeValue = newValue === null ? undefined : newValue === "false" ? false : newValue;
    }
    this.requestReload();
  }

  reload(): Promise<void> {
    this.explicitlyDisposed = false;
    const generation = ++this.generation;
    return this.enqueue(() => this.replacePlayer(generation));
  }

  async start(): Promise<void> {
    prepareStoryAudio();
    const handle = this.handleValue ?? (await this.ready);
    if (!this.connected || this.explicitlyDisposed) {
      throw new ReferenceError("The Vega player element is not active");
    }
    if (!this.started) {
      if (this.entryKey) handle.player.navigateToKey(this.entryKey);
      this.started = true;
    }
    if (handle.shell) {
      handle.shell.resume();
      return;
    }
    handle.player.resume();
    if (!handle.player.state.playing) this.trackPlayback(handle.player.play());
  }

  pause(): void {
    const handle = this.handleValue;
    if (handle?.shell) handle.shell.pause();
    else handle?.player.pause();
  }

  resume(): Promise<void> {
    return this.start();
  }

  dispose(): Promise<void> {
    this.explicitlyDisposed = true;
    this.generation += 1;
    this.rejectReady(abortError("The Vega player element was disposed"));
    return this.enqueue(() => this.releaseActive());
  }

  private requestReload(): void {
    if (!this.connected) return;
    void this.reload().catch(() => undefined);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.catch((error: unknown) => {
      this.rejectReady(error);
      this.reportError(error);
    });
    return result;
  }

  private async replacePlayer(generation: number): Promise<void> {
    await this.releaseActive();
    if (!this.connected || generation !== this.generation || !this.stageElement) return;
    const binding = sourceBinding(this.storyValue, this.projectValue, this.sceneId);
    if (!binding) return;

    const engine = this.engineValue ?? createVega(this.engineOptionsValue);
    const ownsEngine = !this.engineValue;
    this.activeEngine = engine;
    this.ownsActiveEngine = ownsEngine;
    this.entryKey = binding.entryKey;
    this.errorValue = null;
    this.explicitlyDisposed = false;
    try {
      const handle = await engine.createPlayer({
        ...this.playerOptionsValue,
        mount: this.stageElement,
        story: binding.story,
        ...(this.shellValue !== undefined ? { shell: this.shellValue } : {}),
        ...(this.themeValue !== undefined ? { theme: this.themeValue } : {}),
      });
      if (!this.connected || generation !== this.generation) {
        await handle.dispose();
        if (ownsEngine) await engine.dispose();
        return;
      }
      this.handleValue = handle;
      if (this.entryKey) handle.player.navigateToKey(this.entryKey);
      if (handle.player.state.autoPlay !== this.autoPlay) handle.player.toggleAuto();
      this.renderState(handle.player.state);
      this.frame = requestAnimationFrame(() => this.updatePresentation(handle.player.state));
      this.resolveReady(handle);
      this.dispatchEvent(
        new CustomEvent<VegaPlayerElementReadyDetail>("vega-ready", {
          bubbles: true,
          composed: true,
          detail: { element: this, handle },
        }),
      );
      if (this.autoStartValue) await this.start();
    } catch (error) {
      if (ownsEngine) await engine.dispose().catch(() => undefined);
      if (this.activeEngine === engine) {
        this.activeEngine = null;
        this.ownsActiveEngine = false;
      }
      throw error;
    }
  }

  private async releaseActive(): Promise<void> {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastSignature = "";
    this.lastReportedStateError = "";
    this.started = false;
    this.playback = null;
    this.entryKey = undefined;
    const handle = this.handleValue;
    const engine = this.activeEngine;
    const ownsEngine = this.ownsActiveEngine;
    this.handleValue = null;
    this.activeEngine = null;
    this.ownsActiveEngine = false;
    const results = await Promise.allSettled([handle?.dispose(), ownsEngine ? engine?.dispose() : undefined]);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(({ reason }) => reason);
    if (errors.length) throw new AggregateError(errors, "Failed to dispose Vega Web Component resources");
  }

  private trackPlayback(operation: Promise<void>): void {
    this.playback = operation;
    void operation.catch((error: unknown) => {
      if (this.connected && !this.explicitlyDisposed) this.reportError(error);
    });
  }

  private updatePresentation(state: AdvPlayerState): void {
    if (!this.connected || !this.handleValue) return;
    const signature = uiSignature(state);
    if (signature !== this.lastSignature) this.renderState(state);
    if (state.error && state.error !== this.lastReportedStateError) {
      this.lastReportedStateError = state.error;
      this.reportError(new Error(state.error));
    }
    this.frame = requestAnimationFrame(() => this.updatePresentation(state));
  }

  private renderState(state: AdvPlayerState): void {
    this.lastSignature = uiSignature(state);
    if (!this.errorElement) return;
    this.errorElement.hidden = !state.error;
    this.errorElement.textContent = state.error;
    this.setAttribute("aria-busy", state.loading ? "true" : "false");
  }

  private ensureDom(): void {
    if (this.shadowRoot) return;
    const shadow = this.attachShadow({ mode: "open" });
    adoptStyleSheet(shadow);
    shadow.innerHTML = template;
    this.stageElement = shadow.querySelector('[part="stage"]');
    this.errorElement = shadow.querySelector('[part="error"]');
  }

  private resolveReady(handle: VegaPlayerHandle): void {
    for (const waiter of this.readyWaiters) waiter.resolve(handle);
    this.readyWaiters.clear();
  }

  private rejectReady(error: unknown): void {
    for (const waiter of this.readyWaiters) waiter.reject(error);
    this.readyWaiters.clear();
  }

  private reportError(error: unknown): void {
    this.errorValue = error;
    if (this.errorElement) {
      this.errorElement.hidden = false;
      this.errorElement.textContent = error instanceof Error ? error.message : String(error);
    }
    this.dispatchEvent(
      new CustomEvent<VegaPlayerElementErrorDetail>("vega-error", {
        bubbles: true,
        composed: true,
        detail: { element: this, error },
      }),
    );
  }
}

export const defineVegaPlayerElement = (
  tagName = "vega-player",
  registry: CustomElementRegistry | undefined = globalThis.customElements,
): typeof VegaPlayerElement => {
  if (!registry) throw new ReferenceError("Custom elements are not available in this environment");
  const existing = registry.get(tagName);
  if (existing && existing !== VegaPlayerElement) {
    throw new Error(`Custom element ${tagName} is already defined by another constructor`);
  }
  if (!existing) registry.define(tagName, VegaPlayerElement);
  return VegaPlayerElement;
};
