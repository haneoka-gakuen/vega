import type { VegaJsonValue, VegaNarrativePosition, VegaSaveData } from "@haneoka/vega-protocol";
import { VegaNarrativeStore } from "./state";

const MAX_SAVE_BYTES = 8 * 1024 * 1024;
const SLOT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PREVIEW_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/iu;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface VegaSaveStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
}

export interface VegaSaveRepositoryOptions {
  readonly projectId: string;
  readonly projectFormatVersion?: number;
  readonly engineVersion: string;
  readonly storage: VegaSaveStorage;
  readonly namespace?: string;
}

export interface VegaSavePlayerSnapshot {
  readonly commandIndex: number;
  readonly choiceRecords?: readonly (readonly [number, VegaJsonValue])[];
  readonly choicePositions?: readonly {
    readonly position: VegaNarrativePosition;
    readonly value: VegaJsonValue;
  }[];
  readonly stage?: VegaJsonValue;
  readonly audio?: VegaJsonValue;
}

export interface VegaSavePresentation {
  readonly speaker?: string;
  readonly text?: string;
  readonly previewImage?: string;
}

export class VegaSaveRepository {
  private readonly prefix: string;

  constructor(private readonly options: VegaSaveRepositoryOptions) {
    if (!options.projectId.trim()) throw new TypeError("Vega save repository requires a project id");
    this.prefix = `${sanitizeNamespace(options.namespace || "vega")}:${encodeURIComponent(options.projectId)}:save:`;
  }

  async save(
    slot: string,
    position: VegaNarrativePosition,
    narrative: VegaNarrativeStore,
    player: VegaSavePlayerSnapshot,
    label?: string,
    presentation?: VegaSavePresentation,
  ): Promise<VegaSaveData> {
    assertSlot(slot);
    if (position.boundary !== undefined && position.boundary !== "before" && position.boundary !== "after")
      throw new TypeError("Invalid saved command boundary");
    const previous = await this.load(slot);
    const now = new Date().toISOString();
    const save: VegaSaveData = {
      format: "vega-save",
      formatVersion: 1,
      engineVersion: this.options.engineVersion,
      projectId: this.options.projectId,
      projectFormatVersion: this.options.projectFormatVersion ?? 1,
      slot,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
      ...(label?.trim() ? { label: label.trim().slice(0, 256) } : {}),
      ...normalizePresentation(presentation),
      position: {
        sceneId: requireNonEmpty(position.sceneId, "position.sceneId"),
        commandIndex: nonNegativeInteger(position.commandIndex, "position.commandIndex"),
        ...(position.commandId
          ? {
              commandId: requireNonEmpty(position.commandId, "position.commandId"),
              boundary: position.boundary ?? "before",
            }
          : {}),
      },
      narrative: narrative.snapshot(),
      player: {
        commandIndex: nonNegativeInteger(player.commandIndex, "player.commandIndex"),
        choiceRecords: cloneJson(player.choiceRecords ?? []),
        ...(player.choicePositions ? { choicePositions: cloneJson(player.choicePositions) } : {}),
        ...(player.stage === undefined ? {} : { stage: cloneJson(player.stage) }),
        ...(player.audio === undefined ? {} : { audio: cloneJson(player.audio) }),
      },
    };
    const serialized = JSON.stringify(save);
    assertSerializedSaveSize(serialized, "Vega save");
    await this.options.storage.write(this.key(slot), serialized);
    return save;
  }

  async load(slot: string): Promise<VegaSaveData | null> {
    assertSlot(slot);
    const serialized = await this.options.storage.read(this.key(slot));
    if (serialized == null) return null;
    assertSerializedSaveSize(serialized, "Stored Vega save");
    return parseVegaSave(serialized, this.options.projectId);
  }

  async list(): Promise<readonly VegaSaveData[]> {
    const keys = await this.options.storage.list(this.prefix);
    const saves = await Promise.all(
      keys.map(async (key) => {
        const serialized = await this.options.storage.read(key);
        if (serialized == null) return null;
        try {
          assertSerializedSaveSize(serialized, "Stored Vega save");
          return parseVegaSave(serialized, this.options.projectId);
        } catch {
          return null;
        }
      }),
    );
    return saves
      .filter((save): save is VegaSaveData => save !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async remove(slot: string): Promise<void> {
    assertSlot(slot);
    await this.options.storage.remove(this.key(slot));
  }

  async restoreNarrative(slot: string, narrative: VegaNarrativeStore): Promise<VegaSaveData> {
    const save = await this.load(slot);
    if (!save) throw new ReferenceError(`Vega save slot does not exist: ${slot}`);
    narrative.restore(save.narrative);
    return save;
  }

  private key(slot: string): string {
    return `${this.prefix}${slot}`;
  }
}

export class VegaMemorySaveStorage implements VegaSaveStorage {
  private readonly entries = new Map<string, string>();

  async read(key: string): Promise<string | null> {
    return this.entries.get(key) ?? null;
  }

  async write(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async list(prefix: string): Promise<readonly string[]> {
    return [...this.entries.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

export class VegaLocalStorageSaveStorage implements VegaSaveStorage {
  constructor(private readonly storage: Storage = globalThis.localStorage) {}

  async read(key: string): Promise<string | null> {
    return this.storage.getItem(key);
  }

  async write(key: string, value: string): Promise<void> {
    this.storage.setItem(key, value);
  }

  async remove(key: string): Promise<void> {
    this.storage.removeItem(key);
  }

  async list(prefix: string): Promise<readonly string[]> {
    const keys: string[] = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys.sort();
  }
}

export const parseVegaSave = (source: string | unknown, expectedProjectId?: string): VegaSaveData => {
  const value = typeof source === "string" ? parseJson(source) : source;
  assertSafeJson(value, "$", 0, { nodes: 0 });
  const save = record(value, "$");
  if (save.format !== "vega-save" || save.formatVersion !== 1) throw new TypeError("Unsupported Vega save format");
  const projectId = requireNonEmpty(save.projectId, "projectId");
  if (expectedProjectId && projectId !== expectedProjectId) {
    throw new RangeError(`Save belongs to ${projectId}, expected ${expectedProjectId}`);
  }
  requireNonEmpty(save.engineVersion, "engineVersion");
  requireNonEmpty(save.slot, "slot");
  requireIsoDate(save.createdAt, "createdAt");
  requireIsoDate(save.updatedAt, "updatedAt");
  nonNegativeInteger(save.projectFormatVersion, "projectFormatVersion");
  const position = record(save.position, "position");
  requireNonEmpty(position.sceneId, "position.sceneId");
  nonNegativeInteger(position.commandIndex, "position.commandIndex");
  if (position.commandId !== undefined) requireNonEmpty(position.commandId, "position.commandId");
  if (position.boundary !== undefined && position.boundary !== "before" && position.boundary !== "after")
    throw new TypeError("Invalid saved command boundary");
  const narrative = record(save.narrative, "narrative");
  record(narrative.variables, "narrative.variables");
  array(narrative.sceneStack, "narrative.sceneStack");
  array(narrative.readCommands, "narrative.readCommands");
  array(narrative.visitedFlowNodes, "narrative.visitedFlowNodes");
  record(narrative.unlocks, "narrative.unlocks");
  array(narrative.backlog, "narrative.backlog");
  record(narrative.settings, "narrative.settings");
  const player = record(save.player, "player");
  nonNegativeInteger(player.commandIndex, "player.commandIndex");
  array(player.choiceRecords, "player.choiceRecords");
  if (player.choicePositions !== undefined)
    for (const raw of array(player.choicePositions, "player.choicePositions")) {
      const entry = record(raw, "choice position"),
        reference = record(entry.position, "choice position reference");
      requireNonEmpty(reference.sceneId, "choice scene");
      nonNegativeInteger(reference.commandIndex, "choice command index");
      if (reference.commandId !== undefined) requireNonEmpty(reference.commandId, "choice command id");
      if (reference.boundary !== undefined && reference.boundary !== "before" && reference.boundary !== "after")
        throw new TypeError("Invalid choice command boundary");
    }
  if (save.presentation !== undefined) {
    const presentation = record(save.presentation, "presentation");
    optionalString(presentation.speaker, "presentation.speaker");
    optionalString(presentation.text, "presentation.text");
    if (presentation.previewImage !== undefined) {
      const previewImage = optionalString(presentation.previewImage, "presentation.previewImage");
      assertPreviewImage(previewImage);
    }
  }
  return cloneJson(save) as unknown as VegaSaveData;
};

const parseJson = (source: string): unknown => {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new TypeError(error instanceof Error ? `Invalid Vega save: ${error.message}` : "Invalid Vega save");
  }
};

const assertSafeJson = (value: unknown, path: string, depth: number, budget: { nodes: number }): void => {
  budget.nodes += 1;
  if (depth > 128 || budget.nodes > 1_000_000) throw new RangeError("Vega save structure is too complex");
  if (value == null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeJson(entry, `${path}[${index}]`, depth + 1, budget));
    return;
  }
  const object = record(value, path);
  for (const [key, entry] of Object.entries(object)) {
    if (BLOCKED_KEYS.has(key)) throw new TypeError(`${path}.${key} is not allowed`);
    assertSafeJson(entry, `${path}.${key}`, depth + 1, budget);
  }
};

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
  return value as Record<string, unknown>;
};

const array = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
};

const requireNonEmpty = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
};

const optionalString = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
};

const normalizePresentation = (
  presentation: VegaSavePresentation | undefined,
): { readonly presentation: VegaSavePresentation } | Record<string, never> => {
  if (!presentation) return {};
  const speaker = presentation.speaker?.trim().slice(0, 256);
  const text = presentation.text?.trim().slice(0, 2_048);
  const previewImage = presentation.previewImage?.trim();
  assertPreviewImage(previewImage);
  if (!speaker && !text && !previewImage) return {};
  return {
    presentation: {
      ...(speaker ? { speaker } : {}),
      ...(text ? { text } : {}),
      ...(previewImage ? { previewImage } : {}),
    },
  };
};

const assertPreviewImage = (value: string | undefined): void => {
  if (value && !PREVIEW_IMAGE_PATTERN.test(value)) {
    throw new TypeError("presentation.previewImage must be a PNG, JPEG, or WebP data URL");
  }
};

const assertSerializedSaveSize = (serialized: string, label: string): void => {
  if (new TextEncoder().encode(serialized).byteLength > MAX_SAVE_BYTES) {
    throw new RangeError(`${label} exceeds ${MAX_SAVE_BYTES} bytes`);
  }
};

const nonNegativeInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return Number(value);
};

const requireIsoDate = (value: unknown, label: string): string => {
  const text = requireNonEmpty(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${label} must be an ISO date`);
  return text;
};

const assertSlot = (slot: string): void => {
  if (!SLOT_PATTERN.test(slot)) throw new TypeError(`Unsafe Vega save slot: ${String(slot)}`);
};

const sanitizeNamespace = (namespace: string): string => {
  const normalized = namespace
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .slice(0, 64);
  if (!normalized) throw new TypeError("Vega save namespace cannot be empty");
  return normalized;
};

const cloneJson = <T>(value: T): T => {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
};
