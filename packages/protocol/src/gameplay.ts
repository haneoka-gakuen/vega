import type { VegaJsonValue } from "./model.js";

import { VEGA_SYSTEM_OPCODE, type VegaSystemOpcode } from "./opcodes.js";

export type VegaVariableOperation = "set" | "add" | "subtract" | "multiply" | "divide" | "toggle";
export type VegaUnlockKind = "cg" | "bgm" | "scene" | "achievement";

export interface VegaNarrativeSettings {
  readonly textSpeed: number;
  readonly autoDelay: number;
  readonly masterVolume: number;
  readonly bgmVolume: number;
  readonly voiceVolume: number;
  readonly seVolume: number;
  readonly language: string;
  readonly uiLanguage: string;
  readonly reducedMotion: boolean;
  readonly highContrast: boolean;
  readonly instantText?: boolean;
  readonly textSize?: number;
  readonly subtitlesEnabled?: boolean;
  readonly bgmEnabled?: boolean;
}

export interface VegaNarrativePosition {
  readonly sceneId: string;
  readonly commandId?: string;
  readonly boundary?: "before" | "after";
  readonly commandIndex: number;
}

export interface VegaSceneFrame {
  readonly sceneId: string;
  readonly callerId?: string;
  readonly returnKey: string;
}

export interface VegaBacklogEntry {
  readonly id: string;
  readonly commandId?: string;
  readonly sceneId: string;
  readonly commandIndex: number;
  readonly speaker: string;
  readonly text: string;
  readonly textSource?: VegaJsonValue;
  readonly textSources?: readonly VegaJsonValue[];
  readonly speakerSources?: readonly VegaJsonValue[];
  readonly speakerSeparator?: string;
  readonly voice?: string;
  readonly createdAt: string;
}

export interface VegaNarrativeState {
  readonly variables: Readonly<Record<string, VegaJsonValue>>;
  readonly sceneStack: readonly VegaSceneFrame[];
  readonly readCommands: readonly string[];
  readonly visitedFlowNodes: readonly string[];
  readonly unlocks: Readonly<Record<VegaUnlockKind, readonly string[]>>;
  readonly backlog: readonly VegaBacklogEntry[];
  readonly settings: VegaNarrativeSettings;
}

export interface VegaSaveData {
  readonly format: "vega-save";
  readonly formatVersion: 1;
  readonly engineVersion: string;
  readonly projectId: string;
  readonly projectFormatVersion: number;
  readonly slot: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly label?: string;
  /** Optional, renderer-neutral information used by visual save/load screens. */
  readonly presentation?: {
    readonly speaker?: string;
    readonly text?: string;
    readonly previewImage?: string;
  };
  readonly position: VegaNarrativePosition;
  readonly narrative: VegaNarrativeState;
  readonly player: {
    readonly commandIndex: number;
    readonly choiceRecords: readonly (readonly [number, VegaJsonValue])[];
    readonly choicePositions?: readonly {
      readonly position: VegaNarrativePosition;
      readonly value: VegaJsonValue;
    }[];
    readonly stage?: VegaJsonValue;
    readonly audio?: VegaJsonValue;
  };
}

export const isVegaSystemOpcode = (value: unknown): value is VegaSystemOpcode =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  Object.values(VEGA_SYSTEM_OPCODE).includes(value as VegaSystemOpcode);
