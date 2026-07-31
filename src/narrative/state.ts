import type {
  VegaBacklogEntry,
  VegaJsonValue,
  VegaNarrativeSettings,
  VegaNarrativeState,
  VegaSceneFrame,
  VegaUnlockKind,
  VegaVariableOperation,
} from "@haneoka/vega-protocol";
import { evaluateVegaExpression, type VegaExpressionScope } from "./expression";

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const DEFAULT_NARRATIVE_SETTINGS: VegaNarrativeSettings = Object.freeze({
  textSpeed: 1,
  autoDelay: 1.5,
  masterVolume: 1,
  bgmVolume: 0.8,
  voiceVolume: 1,
  seVolume: 0.9,
  language: "auto",
  uiLanguage: "auto",
  reducedMotion: false,
  highContrast: false,
});

export class VegaNarrativeStore {
  private variablesValue: Record<string, VegaJsonValue> = Object.create(null) as Record<string, VegaJsonValue>;
  private sceneStackValue: VegaSceneFrame[] = [];
  private readCommandsValue = new Set<string>();
  private visitedFlowNodesValue = new Set<string>();
  private unlocksValue: Record<VegaUnlockKind, Set<string>> = {
    cg: new Set(),
    bgm: new Set(),
    scene: new Set(),
    achievement: new Set(),
  };
  private backlogValue: VegaBacklogEntry[] = [];
  private settingsValue: VegaNarrativeSettings = { ...DEFAULT_NARRATIVE_SETTINGS };

  get variables(): VegaExpressionScope {
    return this.variablesValue;
  }

  get settings(): VegaNarrativeSettings {
    return this.settingsValue;
  }

  get sceneStack(): readonly VegaSceneFrame[] {
    return this.sceneStackValue;
  }

  setVariable(
    name: string,
    value: VegaJsonValue | string,
    operation: VegaVariableOperation = "set",
    options: { expression?: boolean } = {},
  ): VegaJsonValue {
    assertStateKey(name);
    const operand = options.expression ? evaluateVegaExpression(String(value), this.variablesValue) : cloneJson(value);
    const current = this.variablesValue[name];
    let result: VegaJsonValue;
    switch (operation) {
      case "set":
        result = operand;
        break;
      case "add":
        result =
          typeof current === "string" || typeof operand === "string"
            ? `${current == null ? "" : String(current)}${operand == null ? "" : String(operand)}`
            : finiteNumber(current) + finiteNumber(operand);
        break;
      case "subtract":
        result = finiteNumber(current) - finiteNumber(operand);
        break;
      case "multiply":
        result = finiteNumber(current) * finiteNumber(operand);
        break;
      case "divide": {
        const divisor = finiteNumber(operand);
        if (divisor === 0) throw new RangeError("Cannot divide a Vega variable by zero");
        result = finiteNumber(current) / divisor;
        break;
      }
      case "toggle":
        result = !Boolean(current);
        break;
    }
    this.variablesValue[name] = result;
    return result;
  }

  setSetting<K extends keyof VegaNarrativeSettings>(key: K, value: VegaNarrativeSettings[K]): void {
    if (!Object.hasOwn(DEFAULT_NARRATIVE_SETTINGS, key)) throw new RangeError(`Unknown Vega setting: ${String(key)}`);
    this.settingsValue = normalizeSettings({ ...this.settingsValue, [key]: value });
  }

  pushScene(frame: VegaSceneFrame): void {
    if (!frame.sceneId.trim() || !frame.returnKey.trim()) throw new TypeError("Scene stack frame is incomplete");
    if (this.sceneStackValue.length >= 256) throw new RangeError("Vega scene call stack exceeds 256 frames");
    this.sceneStackValue.push({ sceneId: frame.sceneId, returnKey: frame.returnKey });
  }

  popScene(): VegaSceneFrame | undefined {
    return this.sceneStackValue.pop();
  }

  markRead(commandId: string): void {
    if (commandId) this.readCommandsValue.add(commandId);
  }

  visitFlowNode(nodeId: string): void {
    if (nodeId) this.visitedFlowNodesValue.add(nodeId);
  }

  unlock(kind: VegaUnlockKind, id: string): void {
    if (!this.unlocksValue[kind]) throw new RangeError(`Unknown unlock kind: ${kind}`);
    if (id) this.unlocksValue[kind].add(id);
  }

  isUnlocked(kind: VegaUnlockKind, id: string): boolean {
    return this.unlocksValue[kind].has(id);
  }

  appendBacklog(entry: VegaBacklogEntry, limit = 2_000): void {
    this.backlogValue.push(cloneJson(entry));
    if (this.backlogValue.length > limit) this.backlogValue.splice(0, this.backlogValue.length - limit);
  }

  snapshot(): VegaNarrativeState {
    return {
      variables: cloneJson(this.variablesValue),
      sceneStack: this.sceneStackValue.map((frame) => ({ ...frame })),
      readCommands: [...this.readCommandsValue],
      visitedFlowNodes: [...this.visitedFlowNodesValue],
      unlocks: {
        cg: [...this.unlocksValue.cg],
        bgm: [...this.unlocksValue.bgm],
        scene: [...this.unlocksValue.scene],
        achievement: [...this.unlocksValue.achievement],
      },
      backlog: cloneJson(this.backlogValue),
      settings: { ...this.settingsValue },
    };
  }

  restore(state: VegaNarrativeState): void {
    const variables = cloneJson(state.variables);
    for (const key of Object.keys(variables)) assertStateKey(key);
    this.variablesValue = Object.assign(Object.create(null) as Record<string, VegaJsonValue>, variables);
    this.sceneStackValue = state.sceneStack.slice(0, 256).map((frame) => ({
      sceneId: requireString(frame.sceneId, "sceneId"),
      returnKey: requireString(frame.returnKey, "returnKey"),
    }));
    this.readCommandsValue = new Set(state.readCommands.filter(Boolean));
    this.visitedFlowNodesValue = new Set(state.visitedFlowNodes.filter(Boolean));
    this.unlocksValue = {
      cg: new Set(state.unlocks.cg.filter(Boolean)),
      bgm: new Set(state.unlocks.bgm.filter(Boolean)),
      scene: new Set(state.unlocks.scene.filter(Boolean)),
      achievement: new Set(state.unlocks.achievement.filter(Boolean)),
    };
    this.backlogValue = cloneJson(state.backlog).slice(-2_000);
    this.settingsValue = normalizeSettings(state.settings);
  }

  reset(options: { preserveSettings?: boolean; preserveUnlocks?: boolean } = {}): void {
    const settings = this.settingsValue;
    const unlocks = this.unlocksValue;
    this.variablesValue = Object.create(null) as Record<string, VegaJsonValue>;
    this.sceneStackValue = [];
    this.readCommandsValue.clear();
    this.visitedFlowNodesValue.clear();
    this.backlogValue = [];
    this.settingsValue = options.preserveSettings ? settings : { ...DEFAULT_NARRATIVE_SETTINGS };
    this.unlocksValue = options.preserveUnlocks
      ? unlocks
      : { cg: new Set(), bgm: new Set(), scene: new Set(), achievement: new Set() };
  }
}

const normalizeSettings = (input: Partial<VegaNarrativeSettings>): VegaNarrativeSettings => ({
  textSpeed: clamp(input.textSpeed, 0.1, 5, DEFAULT_NARRATIVE_SETTINGS.textSpeed),
  autoDelay: clamp(input.autoDelay, 0, 30, DEFAULT_NARRATIVE_SETTINGS.autoDelay),
  masterVolume: clamp(input.masterVolume, 0, 1, DEFAULT_NARRATIVE_SETTINGS.masterVolume),
  bgmVolume: clamp(input.bgmVolume, 0, 1, DEFAULT_NARRATIVE_SETTINGS.bgmVolume),
  voiceVolume: clamp(input.voiceVolume, 0, 1, DEFAULT_NARRATIVE_SETTINGS.voiceVolume),
  seVolume: clamp(input.seVolume, 0, 1, DEFAULT_NARRATIVE_SETTINGS.seVolume),
  language: String(input.language || DEFAULT_NARRATIVE_SETTINGS.language).slice(0, 64),
  uiLanguage: String(input.uiLanguage || DEFAULT_NARRATIVE_SETTINGS.uiLanguage).slice(0, 64),
  reducedMotion: Boolean(input.reducedMotion),
  highContrast: Boolean(input.highContrast),
});

const clamp = (value: unknown, minimum: number, maximum: number, fallback: number): number => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
};

const finiteNumber = (value: unknown): number => {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) throw new TypeError(`Expected a finite number, received ${String(value)}`);
  return number;
};

const assertStateKey = (key: string): void => {
  if (
    typeof key !== "string" ||
    !key.trim() ||
    key.length > 256 ||
    key.split(".").some((part) => !part || BLOCKED_KEYS.has(part))
  ) {
    throw new TypeError(`Unsafe Vega state key: ${String(key)}`);
  }
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`Invalid ${label}`);
  return value;
};

const cloneJson = <T>(value: T): T => {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
};
