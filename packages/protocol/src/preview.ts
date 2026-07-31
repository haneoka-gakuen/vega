import type { VegaJsonValue } from "./model.js";

export const VEGA_PREVIEW_PROTOCOL = "haneoka.vega.preview.v1" as const;

export interface VegaPreviewIdentity {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly editorSessionId: string;
  readonly runtimeInstanceId: string;
}

export interface VegaPreviewCapabilities {
  readonly commands: readonly VegaPreviewCommandName[];
  readonly stageInspection: boolean;
  readonly patching: boolean;
  /** The runtime can cancel or discard work from an older request revision. */
  readonly revisionCancellation?: boolean;
  /** The runtime exposes command-boundary pause, continue, step, and breakpoints. */
  readonly debugging?: boolean;
  /** The runtime can inspect and edit real stage reference frames and transforms. */
  readonly stageTransforms?: boolean;
  readonly transports: readonly ("message-port" | "websocket")[];
}

export interface VegaPreviewBreakpoint {
  readonly commandIndex: number;
  readonly sceneId?: string;
  readonly enabled?: boolean;
}

export interface VegaPreviewPoint2 {
  readonly x: number;
  readonly y: number;
}

export interface VegaPreviewTransform {
  readonly position?: VegaPreviewPoint2;
  readonly scale?: VegaPreviewPoint2;
  readonly rotationDegrees?: number;
  readonly opacity?: number;
}

export interface VegaPreviewReferenceFrame {
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly stageWidth: number;
  readonly stageHeight: number;
}

export type VegaPreviewTargetStatus = "ready" | "missing" | "unsupported";

export interface VegaPreviewReferenceFrameResult {
  readonly target: string;
  readonly status: VegaPreviewTargetStatus;
  readonly frame?: VegaPreviewReferenceFrame;
  readonly reason?: string;
}

export interface VegaPreviewTransformResult {
  readonly target: string;
  readonly status: VegaPreviewTargetStatus;
  readonly transform?: VegaPreviewTransform;
  readonly reason?: string;
}

export interface VegaPreviewBreakpointResult {
  readonly sceneId: string;
  readonly breakpoints: readonly number[];
}

export interface VegaPreviewExecutionSnapshot {
  readonly playing: boolean;
  readonly paused: boolean;
  readonly finished: boolean;
  readonly seeking: boolean;
  readonly pausedBoundaryIndex: number | null;
  readonly breakpoints: readonly number[];
}

export interface VegaPreviewStageSnapshot {
  readonly sceneId: string;
  readonly sceneRevision: string;
  readonly commandIndex: number;
  readonly commandCount: number;
  readonly execution: VegaPreviewExecutionSnapshot;
  readonly variables: VegaJsonValue;
  readonly narrative: VegaJsonValue;
  readonly state: VegaJsonValue;
  readonly camera: VegaJsonValue;
  readonly targets: readonly string[];
}

export const VEGA_PREVIEW_COMMAND_NAMES = Object.freeze([
  "runtime.load",
  "runtime.patch",
  "runtime.play",
  "runtime.pause",
  "runtime.seek",
  "runtime.snapshot",
  "runtime.dispose",
  "editor.sync-scene",
  "editor.run-scene",
  "editor.run-from",
  "editor.run-snippet",
  "debug.continue",
  "debug.step",
  "debug.breakpoints.set",
  "debug.variables",
  "stage.snapshot",
  "stage.reference-frame",
  "stage.transform.get",
  "stage.transform.set",
] as const);

export type VegaPreviewCommandName = (typeof VEGA_PREVIEW_COMMAND_NAMES)[number];

export type VegaPreviewCommand =
  | { readonly name: "runtime.load"; readonly story: VegaJsonValue; readonly commandIndex?: number }
  | { readonly name: "runtime.patch"; readonly patch: readonly VegaJsonPatch[] }
  | { readonly name: "runtime.play" }
  | { readonly name: "runtime.pause" }
  | { readonly name: "runtime.seek"; readonly commandIndex: number }
  | { readonly name: "runtime.snapshot" }
  | { readonly name: "runtime.dispose" }
  | {
      /**
       * Atomically replaces the current editor scene. `sceneRevision` is the
       * document revision used by transform baselines; request ordering still
       * comes from the numeric envelope revision.
       */
      readonly name: "editor.sync-scene";
      readonly sceneId: string;
      readonly sceneRevision: string;
      readonly story: VegaJsonValue;
      readonly commandIndex?: number;
    }
  | { readonly name: "editor.run-scene"; readonly commandIndex?: number }
  | { readonly name: "editor.run-from"; readonly commandIndex: number }
  | { readonly name: "editor.run-snippet"; readonly commands: readonly VegaJsonValue[]; readonly label?: string }
  | { readonly name: "debug.continue" }
  | { readonly name: "debug.step" }
  | { readonly name: "debug.breakpoints.set"; readonly breakpoints: readonly VegaPreviewBreakpoint[] }
  | { readonly name: "debug.variables" }
  | { readonly name: "stage.snapshot" }
  | { readonly name: "stage.reference-frame"; readonly target: string }
  | { readonly name: "stage.transform.get"; readonly target: string }
  | {
      readonly name: "stage.transform.set";
      readonly target: string;
      readonly transform: VegaPreviewTransform;
      readonly phase?: "preview" | "commit";
    };

export interface VegaJsonPatch {
  readonly op: "add" | "remove" | "replace";
  readonly path: string;
  readonly value?: VegaJsonValue;
}

export interface VegaPreviewRequest {
  readonly protocol: typeof VEGA_PREVIEW_PROTOCOL;
  readonly kind: "request";
  readonly identity: VegaPreviewIdentity;
  readonly requestId: string;
  readonly revision: number;
  readonly command: VegaPreviewCommand;
}

export interface VegaPreviewResponse {
  readonly protocol: typeof VEGA_PREVIEW_PROTOCOL;
  readonly kind: "response";
  readonly requestId: string;
  readonly revision: number;
  readonly status: "executed" | "superseded" | "rejected";
  readonly result?: VegaJsonValue;
  readonly error?: { readonly code: string; readonly message: string };
}

export type VegaPreviewEvent =
  | {
      readonly protocol: typeof VEGA_PREVIEW_PROTOCOL;
      readonly kind: "event";
      readonly event: "runtime.ready";
      readonly identity: VegaPreviewIdentity;
      readonly capabilities: VegaPreviewCapabilities;
    }
  | {
      readonly protocol: typeof VEGA_PREVIEW_PROTOCOL;
      readonly kind: "event";
      readonly event: "runtime.state";
      readonly identity: VegaPreviewIdentity;
      readonly revision: number;
      readonly snapshot: VegaJsonValue;
    }
  | {
      readonly protocol: typeof VEGA_PREVIEW_PROTOCOL;
      readonly kind: "event";
      readonly event: "runtime.diagnostic";
      readonly identity: VegaPreviewIdentity;
      readonly level: "info" | "warning" | "error";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly protocol: typeof VEGA_PREVIEW_PROTOCOL;
      readonly kind: "event";
      readonly event: "runtime.stopped";
      readonly identity: VegaPreviewIdentity;
      readonly revision: number;
      readonly reason: "pause" | "breakpoint" | "step" | "end";
      readonly sceneId: string;
      readonly commandIndex: number;
    };

export type VegaPreviewMessage = VegaPreviewRequest | VegaPreviewResponse | VegaPreviewEvent;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isCommandIndex = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPoint2 = (value: unknown): value is VegaPreviewPoint2 =>
  isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);

const isTransform = (value: unknown): value is VegaPreviewTransform => {
  if (!isRecord(value)) return false;
  if (value.position !== undefined && !isPoint2(value.position)) return false;
  if (
    value.scale !== undefined &&
    (!isPoint2(value.scale) || value.scale.x <= 0 || value.scale.y <= 0)
  ) {
    return false;
  }
  if (value.rotationDegrees !== undefined && !isFiniteNumber(value.rotationDegrees)) return false;
  if (value.opacity !== undefined && (!isFiniteNumber(value.opacity) || value.opacity < 0 || value.opacity > 1)) {
    return false;
  }
  return true;
};

const isBreakpoint = (value: unknown): value is VegaPreviewBreakpoint =>
  isRecord(value) &&
  isCommandIndex(value.commandIndex) &&
  (value.sceneId === undefined || isNonEmptyString(value.sceneId)) &&
  (value.enabled === undefined || typeof value.enabled === "boolean");

const isJsonPatch = (value: unknown): value is VegaJsonPatch => {
  if (!isRecord(value) || !["add", "remove", "replace"].includes(String(value.op))) return false;
  if (typeof value.path !== "string" || !value.path.startsWith("/")) return false;
  if ((value.op === "add" || value.op === "replace") && !("value" in value)) return false;
  return true;
};

export const isVegaPreviewIdentity = (value: unknown): value is VegaPreviewIdentity => {
  if (!isRecord(value)) return false;
  return ["workspaceId", "projectId", "editorSessionId", "runtimeInstanceId"].every(
    (key) => isNonEmptyString(value[key]),
  );
};

const isVegaPreviewCommand = (value: unknown): value is VegaPreviewCommand => {
  if (!isRecord(value) || typeof value.name !== "string") return false;
  switch (value.name) {
    case "runtime.load":
      return isRecord(value.story) && (value.commandIndex === undefined || isCommandIndex(value.commandIndex));
    case "runtime.patch":
      return Array.isArray(value.patch) && value.patch.every(isJsonPatch);
    case "runtime.seek":
    case "editor.run-from":
      return isCommandIndex(value.commandIndex);
    case "editor.sync-scene":
      return (
        isNonEmptyString(value.sceneId) &&
        isNonEmptyString(value.sceneRevision) &&
        isRecord(value.story) &&
        (value.commandIndex === undefined || isCommandIndex(value.commandIndex))
      );
    case "editor.run-scene":
      return value.commandIndex === undefined || isCommandIndex(value.commandIndex);
    case "editor.run-snippet":
      return (
        Array.isArray(value.commands) &&
        value.commands.every(isRecord) &&
        (value.label === undefined || typeof value.label === "string")
      );
    case "debug.breakpoints.set":
      return Array.isArray(value.breakpoints) && value.breakpoints.every(isBreakpoint);
    case "stage.reference-frame":
    case "stage.transform.get":
      return isNonEmptyString(value.target);
    case "stage.transform.set":
      return (
        isNonEmptyString(value.target) &&
        isTransform(value.transform) &&
        (value.phase === undefined || value.phase === "preview" || value.phase === "commit")
      );
    case "runtime.play":
    case "runtime.pause":
    case "runtime.snapshot":
    case "runtime.dispose":
    case "debug.continue":
    case "debug.step":
    case "debug.variables":
    case "stage.snapshot":
      return true;
    default:
      return false;
  }
};

export const isVegaPreviewRequest = (value: unknown): value is VegaPreviewRequest => {
  if (!isRecord(value)) return false;
  return (
    value.protocol === VEGA_PREVIEW_PROTOCOL &&
    value.kind === "request" &&
    isNonEmptyString(value.requestId) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    isVegaPreviewIdentity(value.identity) &&
    isVegaPreviewCommand(value.command)
  );
};

export const isVegaPreviewMessage = (value: unknown): value is VegaPreviewMessage => {
  if (!isRecord(value) || value.protocol !== VEGA_PREVIEW_PROTOCOL) return false;
  if (value.kind === "request") return isVegaPreviewRequest(value);
  if (value.kind === "response") {
    if (
      !isNonEmptyString(value.requestId) ||
      !isCommandIndex(value.revision) ||
      !["executed", "superseded", "rejected"].includes(String(value.status))
    ) {
      return false;
    }
    if (value.error !== undefined) {
      if (
        !isRecord(value.error) ||
        !isNonEmptyString(value.error.code) ||
        typeof value.error.message !== "string"
      ) {
        return false;
      }
    }
    return value.status !== "rejected" || value.error !== undefined;
  }
  if (value.kind !== "event" || !isVegaPreviewIdentity(value.identity)) return false;
  switch (value.event) {
    case "runtime.ready":
      return isCapabilities(value.capabilities);
    case "runtime.state":
      return isCommandIndex(value.revision) && "snapshot" in value;
    case "runtime.diagnostic":
      return (
        ["info", "warning", "error"].includes(String(value.level)) &&
        isNonEmptyString(value.code) &&
        typeof value.message === "string"
      );
    case "runtime.stopped":
      return (
        isCommandIndex(value.revision) &&
        ["pause", "breakpoint", "step", "end"].includes(String(value.reason)) &&
        isNonEmptyString(value.sceneId) &&
        isCommandIndex(value.commandIndex)
      );
    default:
      return false;
  }
};

const isCapabilities = (value: unknown): value is VegaPreviewCapabilities => {
  if (!isRecord(value) || !Array.isArray(value.commands) || !Array.isArray(value.transports)) return false;
  const knownCommands = new Set<string>(VEGA_PREVIEW_COMMAND_NAMES);
  return (
    value.commands.every((command) => typeof command === "string" && knownCommands.has(command)) &&
    typeof value.stageInspection === "boolean" &&
    typeof value.patching === "boolean" &&
    (value.revisionCancellation === undefined || typeof value.revisionCancellation === "boolean") &&
    (value.debugging === undefined || typeof value.debugging === "boolean") &&
    (value.stageTransforms === undefined || typeof value.stageTransforms === "boolean") &&
    value.transports.every((transport) => transport === "message-port" || transport === "websocket")
  );
};
