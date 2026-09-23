import {
  VEGA_SYSTEM_OPCODE,
  type VegaJsonValue,
  type VegaNarrativeSettings,
  type VegaUnlockKind,
  type VegaVariableOperation,
} from "@haneoka/vega-protocol";
import type { AdvCommandExecutor } from "../core/AdvCommandService";
import type { AdvCommand } from "../types/AdvRuntime";
import { evaluateVegaCondition, interpolateVegaText } from "./expression";
import { vegaSceneKey } from "./project";
import { VegaNarrativeStore } from "./state";

export interface VegaNarrativeInputRequest {
  readonly variable: string;
  readonly prompt: string;
  readonly defaultValue: VegaJsonValue;
  readonly inputType: "text" | "number" | "password";
  readonly maximumLength: number;
  readonly signal?: AbortSignal;
}

export type VegaNarrativeInputProvider = (request: VegaNarrativeInputRequest) => Promise<VegaJsonValue | undefined>;

export interface VegaNarrativeCommandHost {
  readonly store: VegaNarrativeStore;
  navigateToKey(key: string): void;
  finish(): void;
  input?: VegaNarrativeInputProvider;
  onSceneChange?(sceneId: string): void;
  onFlowCheckpoint?(nodeId: string): void;
  onUnlock?(kind: VegaUnlockKind, id: string): void;
}

export interface VegaSystemCommandRegistration {
  readonly opcode: number;
  readonly execute: AdvCommandExecutor;
}

export const createVegaSystemCommands = (host: VegaNarrativeCommandHost): readonly VegaSystemCommandRegistration[] => [
  {
    opcode: VEGA_SYSTEM_OPCODE.SetDialogueVisibility,
    execute(command, context) {
      if (typeof command.enabled !== "boolean") throw new TypeError("SetDialogueVisibility.enabled must be a boolean");
      context.state.talk.enabled = command.enabled;
    },
  },
  {
    opcode: VEGA_SYSTEM_OPCODE.SetVariable,
    execute(command) {
      const variable = requiredString(command.variable ?? command.name, "SetVariable.variable");
      const operation = variableOperation(command.operation);
      const value = toJsonValue(command.value ?? command.params?.[0] ?? null);
      host.store.setVariable(variable, value, operation, {
        expression: Boolean(command.expression),
      });
    },
  },
  {
    opcode: VEGA_SYSTEM_OPCODE.Branch,
    execute(command) {
      const condition = requiredString(command.condition ?? command.params?.[0], "Branch.condition");
      const matched = evaluateVegaCondition(condition, host.store.variables);
      const key = matched
        ? optionalString(command.thenKey) || sceneTarget(command.thenScene)
        : optionalString(command.elseKey) || sceneTarget(command.elseScene);
      if (key) host.navigateToKey(key);
    },
  },
  {
    opcode: VEGA_SYSTEM_OPCODE.JumpScene,
    execute(command) {
      host.navigateToKey(optionalString(command.targetKey) || sceneTarget(command.sceneId, true));
    },
  },
  {
    opcode: VEGA_SYSTEM_OPCODE.CallScene,
    execute(command) {
      const returnKey = requiredString(command.returnKey, "CallScene.returnKey");
      const currentScene = optionalString(command.currentScene) || optionalString(command.sceneSource) || "";
      host.store.pushScene({
        sceneId: currentScene || "unknown",
        returnKey,
        ...(currentScene && optionalString(command.commandId) ? { callerId: optionalString(command.commandId)! } : {}),
      });
      host.navigateToKey(optionalString(command.targetKey) || sceneTarget(command.sceneId, true));
    },
  },
  {
    opcode: VEGA_SYSTEM_OPCODE.ReturnScene,
    execute() {
      const frame = host.store.popScene();
      if (frame) host.navigateToKey(frame.returnKey);
      else host.finish();
    },
  },
  {
    opcode: VEGA_SYSTEM_OPCODE.Input,
    async execute(command, _context, signal) {
      const variable = requiredString(command.variable ?? command.name, "Input.variable");
      const provider = host.input;
      if (!provider) throw new ReferenceError("Vega Input command requires an input provider");
      const prompt = interpolateVegaText(String(command.prompt ?? command.text ?? ""), host.store.variables);
      const value = await provider({
        variable,
        prompt,
        defaultValue: toJsonValue(command.defaultValue ?? ""),
        inputType: inputType(command.inputType),
        maximumLength: clampInteger(command.maximumLength, 1, 10_000, 256),
        signal,
      });
      if (value !== undefined) host.store.setVariable(variable, value);
    },
  },
  {
    opcode: VEGA_SYSTEM_OPCODE.Unlock,
    execute(command) {
      const kind = unlockKind(command.unlockKind ?? command.kind);
      const id = requiredString(command.unlockId ?? command.id ?? command.params?.[0], "Unlock.id");
      host.store.unlock(kind, id);
      host.onUnlock?.(kind, id);
    },
  },
  {
    opcode: VEGA_SYSTEM_OPCODE.FlowCheckpoint,
    execute(command) {
      const id = requiredString(command.flowNodeId ?? command.id ?? command.key, "FlowCheckpoint.id");
      host.store.visitFlowNode(id);
      host.onFlowCheckpoint?.(id);
    },
  },
  {
    opcode: VEGA_SYSTEM_OPCODE.SetSetting,
    execute(command) {
      const key = requiredString(command.setting ?? command.name, "SetSetting.setting") as keyof VegaNarrativeSettings;
      host.store.setSetting(key, command.value as never);
    },
  },
  {
    opcode: VEGA_SYSTEM_OPCODE.End,
    execute(command) {
      if (command.returnIfCalled) {
        const frame = host.store.popScene();
        if (frame) {
          host.navigateToKey(frame.returnKey);
          return;
        }
      }
      host.finish();
    },
  },
  {
    opcode: VEGA_SYSTEM_OPCODE.SceneMarker,
    execute(command) {
      if (command.returnMarker) return;
      const sceneId = requiredString(command.sceneId, "SceneMarker.sceneId");
      host.store.unlock("scene", sceneId);
      host.onSceneChange?.(sceneId);
    },
  },
];

export const interpolateNarrativeCommand = (command: AdvCommand, store: VegaNarrativeStore): AdvCommand => {
  const copy = { ...command };
  for (const field of ["text", "advText", "speaker", "targetName", "title", "prompt"] as const) {
    const value = copy[field];
    if (typeof value === "string" && value.includes("{")) copy[field] = interpolateVegaText(value, store.variables);
  }
  if (Array.isArray(copy.params)) {
    copy.params = copy.params.map((value) =>
      typeof value === "string" && value.includes("{") ? interpolateVegaText(value, store.variables) : value,
    );
  }
  return copy;
};

/**
 * Portable `-when` compatibility gate. It is evaluated by the same bounded
 * expression VM used by branches and never invokes JavaScript.
 */
export const matchesNarrativeCommandCondition = (command: AdvCommand, store: VegaNarrativeStore): boolean => {
  if (command.condition == null || command.condition === "") return true;
  if (typeof command.condition !== "string") {
    throw new TypeError("Vega command condition must be a string");
  }
  return evaluateVegaCondition(command.condition, store.variables);
};

const sceneTarget = (value: unknown, required = false): string => {
  const sceneId = optionalString(value);
  if (!sceneId) {
    if (required) throw new TypeError("Scene target must be a non-empty string");
    return "";
  }
  return sceneId.startsWith("vega:scene:") ? sceneId : vegaSceneKey(sceneId);
};

const requiredString = (value: unknown, label: string): string => {
  const text = optionalString(value);
  if (!text) throw new TypeError(`${label} must be a non-empty string`);
  return text;
};

const optionalString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const variableOperation = (value: unknown): VegaVariableOperation => {
  const normalized = optionalString(value) || "set";
  if (!["set", "add", "subtract", "multiply", "divide", "toggle"].includes(normalized)) {
    throw new RangeError(`Unknown Vega variable operation: ${normalized}`);
  }
  return normalized as VegaVariableOperation;
};

const unlockKind = (value: unknown): VegaUnlockKind => {
  const normalized = optionalString(value) || "scene";
  if (!["cg", "bgm", "scene", "achievement"].includes(normalized)) {
    throw new RangeError(`Unknown Vega unlock kind: ${normalized}`);
  }
  return normalized as VegaUnlockKind;
};

const inputType = (value: unknown): VegaNarrativeInputRequest["inputType"] => {
  const normalized = optionalString(value) || "text";
  return normalized === "number" || normalized === "password" ? normalized : "text";
};

const clampInteger = (value: unknown, minimum: number, maximum: number, fallback: number): number => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.floor(number))) : fallback;
};

const toJsonValue = (value: unknown): VegaJsonValue => {
  if (value == null || ["string", "boolean"].includes(typeof value)) return value as VegaJsonValue;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]));
  }
  return String(value);
};
