import { requireCanonicalStoryResourceUrl, resolveStoryLocalizedText, type StoryResolvedText } from "../runtime";
import { ADV_CANVAS_LAYER, ADV_COMMAND, ADV_STAGE_ENV_TYPE, mergeAdvRuntime } from "./AdvConstants";
import { canonicalAdvLocale, resolveAdvLocale } from "./AdvLocalization";
import { AdvCommandGroupScheduler } from "./AdvCommandGroupScheduler";
import { AdvCommandService } from "./AdvCommandService";
import type { AdvCommandContext } from "./AdvCommandService";
import {
  isVegaNativeOpcode,
  isVegaExtensionOpcode,
  isVegaCommandType,
  VEGA_SYSTEM_OPCODE,
  type VegaNarrativeState,
} from "@haneoka/vega-protocol";
import { advAutoPlayReadDelaySeconds, autoPlayIntervalSeconds, normalizeAutoPlayInterval } from "./AdvAutoPlayInterval";
import { AdvEpisodeResourceLoader, type AdvEpisodeResourceSnapshot } from "./AdvEpisodeResourceLoader";
import { prepareStoryCharacterProviders } from "./AdvCharacterProviderPreparation";
import { AdvPlaybackSession, type AdvPlaybackSessionSnapshot } from "./AdvPlaybackSession";
import { AdvPlayerModel } from "./AdvPlayerModel";
import { AdvPlayableDirector } from "./AdvPlayableDirector";
import { AdvQualityConfig } from "./AdvQualityConfig";
import { delaySeconds, type AdvCommandTransitionChannel } from "./time";
import { lerp, resolveEase, tween } from "./easing";
import type {
  AdvCommand,
  AdvRuntimeConfig,
  AdvSoundEntry,
  AdvFrameEntry,
  AdvChatMemoryEntry,
  AdvStory,
  AdvPlayerState,
  AdvRuleTransitionEntry,
  AdvCharacterModelEntry,
  AdvChoiceDefinition,
  AdvChoiceItem,
  AdvChoiceRecord,
} from "../types/AdvRuntime";
import { hasAdvCharacterModel } from "../types/AdvRuntime";
import { GenericStoryScene } from "../rendering/dom/GenericStoryScene";
import type { StoryCharacterProvider } from "../rendering/StoryCharacterModel";
import type { StoryResourceResolver, StorySceneBackend } from "../rendering/StorySceneBackend";
import { DefaultStoryResourceResolver } from "../resources/StoryResourceResolver";
import type { StoryCommandResourcePreparer, StoryResourcePreparer } from "../resources/StoryResourcePreparation";
import { AdvCamera } from "../rendering/AdvCamera";
import { unityCharacterFadeDuration } from "../rendering/AdvCharacterLifecycle";
import { AdvSoundManager, type AdvSoundSnapshot } from "../sound/AdvSoundManager";
import { chatDataRootForWindowAsset, isGroupChatParticipants, resolveAdvChatMaster } from "./AdvChatAssets";
import { advDoFTargets } from "./AdvDoF";
import { deterministicReplayCommand } from "./AdvSeekReplay";
import { createDetachedAdvPlayerState } from "./AdvLifecycleState";
import { sampleAdvLetterboxAnimator } from "../rendering/neutral/AdvFrameLayout";
import { advChatWindowTransitionSeconds } from "./AdvChatTransition";
import {
  ADV_SEEK_CHECKPOINT_VERSION,
  seekDecisionSignature,
  sharedCheckpointIndexFor,
  shareSeekSnapshot,
  releaseCheckpointIndexes,
  type AdvSeekCheckpointIndex,
  type AdvSeekCheckpoint,
} from "./checkpointCache";
import type { AdvStorySceneSeekSnapshot } from "../rendering/neutral/StorySceneSnapshot";
import { hasSemanticAdvText, splitAdvTargetNames } from "./AdvCommandText";
import { flattenAdvCommands } from "./AdvCommandTraversal";
import {
  createVegaSystemCommands,
  interpolateNarrativeCommand,
  matchesNarrativeCommandCondition,
  type VegaNarrativeInputProvider,
} from "../narrative/commands";
import { evaluateVegaCondition, type VegaExpressionScope } from "../narrative/expression";
import { VegaNarrativeStore } from "../narrative/state";

type AdvCommandHandler = (cmd: AdvCommand, ctx: AdvCommandContext, signal?: AbortSignal) => Promise<void> | void;

export interface AdvPlayerExecutionBoundary {
  readonly phase: "before" | "started" | "after";
  readonly commandIndex: number;
  readonly command: AdvCommand;
}

export type AdvPlayerExecutionObserver = (boundary: AdvPlayerExecutionBoundary) => Promise<void> | void;

export interface AdvCommandExtensionRegistration extends StoryCommandResourcePreparer {
  readonly opcode: number;
  readonly commandType: string;
  readonly execute: AdvCommandHandler;
  readonly authority?: "official" | "third-party";
  /** The handler is deterministic when `Model.shouldShortCut` is true. */
  readonly replaySafe?: boolean;
}
type AdvSeekRequest = {
  generation: number;
  target: number;
  paused: boolean;
  resume: boolean;
  controller: AbortController;
  completion: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

type AdvSeekIndexBuild = {
  readonly signature: string;
  readonly promise: Promise<AdvSeekCheckpointIndex>;
};

interface AdvWaitingMotion {
  remainingSeconds: number;
  readonly identity: string;
  readonly play: () => void;
}

interface AdvCharacterMotionQueue {
  current: AdvWaitingMotion;
  readonly queued: AdvWaitingMotion[];
}

interface AdvCharacterDoFCommandOwner {
  readonly controller: AbortController;
  target: string;
}

// UIAdvChatWidget/AdvChatView prefab, MonoBehaviour_2.asset::_typingDelay.
// ShowTypingTextAsync divides it by max(_playbackSpeed, 0.01f) before
// constructing TypingTask.
const ADV_CHAT_TYPING_DELAY_SECONDS = 0.03;
const ADV_CHAT_MIN_PLAYBACK_SPEED = 0.01;

const SEEK_PLAYER_STATE_KEYS = [
  "pluginState",
  "stage",
  "background",
  "still",
  "frame",
  "frameName",
  "frameOpacity",
  "frameSlide",
  "frameEntries",
  "stageEnv",
  "postEffect",
  "dofActive",
  "effect",
  "cover",
  "talk",
  "title",
  "location",
  "subtitles",
  "chat",
  "choices",
  "video",
  "audio",
  "finished",
  "unknownCommands",
  "unsupported",
] as const satisfies readonly (keyof AdvPlayerState)[];

type AdvPlayerSeekStateKey = (typeof SEEK_PLAYER_STATE_KEYS)[number];

interface AdvPlayerSeekStateSnapshot {
  readonly presentation: Pick<AdvPlayerState, AdvPlayerSeekStateKey>;
  readonly narrative: VegaNarrativeState;
  readonly model: {
    readonly forcedAutoPlay: boolean;
  };
}

type StorySeekCheckpoint = AdvSeekCheckpoint<
  AdvStorySceneSeekSnapshot,
  AdvPlaybackSessionSnapshot,
  AdvEpisodeResourceSnapshot,
  AdvSoundSnapshot,
  AdvPlayerSeekStateSnapshot
>;

const ABORTED_CHOICE = Symbol("aborted-choice");

const localizedText = (value: unknown): StoryResolvedText => resolveStoryLocalizedText(value);
function tryParseInt32(value: unknown): number | null {
  const source = String(value ?? "").trim();
  if (!/^[+-]?\d+$/.test(source)) return null;
  const parsed = Number(source);
  return Number.isInteger(parsed) && parsed >= -2147483648 && parsed <= 2147483647 ? parsed : null;
}

/** Mirrors the case-sensitive Enum.TryParse call whose false result leaves All (zero) in the out slot. */
function stageEnvType(value: unknown): number {
  const source = String(value ?? "").trim();
  const named = ADV_STAGE_ENV_TYPE[source as keyof typeof ADV_STAGE_ENV_TYPE];
  return named ?? tryParseInt32(source) ?? ADV_STAGE_ENV_TYPE.All;
}

function clonePlain<T>(value: T): T {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function seekDecisionEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function finite(value: unknown, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function isPresent<T>(value: T): value is NonNullable<T> {
  return value != null;
}

function clamp01(value: unknown, fallback = 0) {
  return Math.max(0, Math.min(1, finite(value, fallback)));
}

function nowSeconds() {
  return (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
}

function soundDurationSeconds(sound: AdvSoundEntry | null | undefined) {
  if (!sound) return 0;
  const durationMs = finite(sound.durationMs, 0);
  if (durationMs > 0) return durationMs / 1000;
  const durationSeconds = finite(sound.durationSeconds ?? sound.durationSec, 0);
  if (durationSeconds > 0) return durationSeconds;
  const totalSamples = finite(sound.totalSamples, 0);
  const sampleRate = finite(sound.sampleRate, 0);
  return totalSamples > 0 && sampleRate > 0 ? totalSamples / sampleRate : 0;
}

function maxSoundDurationSeconds(sounds: Array<AdvSoundEntry | null | undefined>) {
  return Math.max(0, ...sounds.map((sound) => soundDurationSeconds(sound)));
}

function param(cmd: AdvCommand, index: number, fallback = "") {
  return cmd?.params?.[index] ?? fallback;
}

function parsedChoiceInteger(value: unknown, label: string): number {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) {
    throw new TypeError(`ADV ChoiceShow ${label} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`ADV ChoiceShow ${label} must be an integer`);
  return parsed;
}

function choiceInteger(value: unknown, label: string): number {
  const parsed = parsedChoiceInteger(value, label);
  if (parsed < -2_147_483_648 || parsed > 2_147_483_647) {
    throw new TypeError(`ADV ChoiceShow ${label} must be a 32-bit integer`);
  }
  return parsed;
}

function choiceCondition(value: unknown, label: string, variables: VegaExpressionScope): boolean | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`ADV ChoiceShow ${label} must be a string`);
  }
  const source = value.trim();
  if (!source) return undefined;
  return evaluateVegaCondition(source, variables);
}

function choiceItems(
  cmd: AdvCommand,
  choiceIndex: number,
  variables: VegaExpressionScope,
  resolve = localizedText,
): AdvChoiceItem[] {
  if (!Array.isArray(cmd.choices) || !cmd.choices.length) {
    throw new TypeError(`ADV ChoiceShow choice group ${choiceIndex} is missing its choices`);
  }
  const advId = parsedChoiceInteger(cmd.advId, "advId");
  const usedValues = new Set<number>();
  const items: AdvChoiceItem[] = [];
  for (const [index, rawChoice] of cmd.choices.entries()) {
    if (!rawChoice || typeof rawChoice !== "object" || Array.isArray(rawChoice)) {
      throw new TypeError(`ADV ChoiceShow choices[${index}] must be an object`);
    }
    const choice = rawChoice as AdvChoiceDefinition;
    const choiceValue = choiceInteger(choice.choiceValue, `choices[${index}].choiceValue`);
    if (usedValues.has(choiceValue)) {
      throw new TypeError(`ADV ChoiceShow choiceValue ${choiceValue} is duplicated`);
    }
    usedValues.add(choiceValue);
    const nextKey = typeof choice.nextKey === "string" ? choice.nextKey : "";
    if (!nextKey) {
      throw new TypeError(`ADV ChoiceShow choices[${index}].nextKey must be a non-empty string`);
    }
    const text = resolve(choice.text);
    if (!text.text) {
      throw new TypeError(`ADV ChoiceShow choices[${index}].text must not be empty`);
    }
    const visible = choiceCondition(choice.visibleWhen, `choices[${index}].visibleWhen`, variables);
    const enabled = choiceCondition(choice.enabledWhen, `choices[${index}].enabledWhen`, variables);
    if (visible === false) continue;
    items.push({
      key: `${choiceIndex}:${choiceValue}`,
      text: text.text,
      sourceText: clonePlain(choice.text),
      lang: text.lang,
      textId: typeof choice.textId === "string" ? choice.textId : undefined,
      nextKey,
      ...(enabled === undefined ? {} : { enabled }),
      record: { advId, choiceIndex, choiceValue },
    });
  }
  return items;
}

function optionalFinite(value: unknown, fallback = 0) {
  if (value == null || String(value).trim() === "") return fallback;
  return finite(value, fallback);
}

function truthy(value: unknown) {
  if (typeof value === "boolean") return value;
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true";
}

function firstTarget(cmd: AdvCommand) {
  return cmd?.targets?.[0]?.target || splitAdvTargetNames(cmd?.targetName)[0] || "";
}

function targetKeys(cmd: AdvCommand) {
  const keys = (cmd?.targets || []).map((target) => target.target).filter((k): k is string => Boolean(k));
  return keys.length ? keys : splitAdvTargetNames(cmd?.targetName);
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function localizedTextEntries(value: unknown, resolve = localizedText): StoryResolvedText[] {
  const entries = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return entries.map(resolve).filter((entry) => Boolean(entry.text.trim()));
}

function joinLocalizedText(entries: readonly StoryResolvedText[], separator: string): StoryResolvedText {
  const values = entries.filter((entry) => Boolean(entry.text));
  if (!values.length) return { text: "" };
  const languages = [...new Set(values.map((entry) => entry.lang).filter((lang): lang is string => Boolean(lang)))];
  return languages.length === 1 && values.every((entry) => entry.lang === languages[0])
    ? {
        text: values.map((entry) => entry.text).join(separator),
        lang: languages[0],
      }
    : { text: values.map((entry) => entry.text).join(separator) };
}

function localizedTextIds(ids: unknown, resolve = localizedText): StoryResolvedText[] {
  return arrayValue(ids)
    .map((id) => String(id || "").trim())
    .filter(Boolean)
    .map(resolve)
    .filter((entry) => Boolean(entry.text));
}

function commandTargetTextIds(cmd: AdvCommand) {
  return (
    cmd?.targetTextIds ??
    cmd?.targetTextIDs ??
    cmd?.TargetTextIDs ??
    cmd?.TargetTextIds ??
    cmd?.raw?.TargetTextIDs ??
    cmd?.raw?.TargetTextIds ??
    []
  );
}

function commandTargetTextNames(cmd: AdvCommand) {
  return cmd?.targetTextNames ?? cmd?.targetTextNamesLocalized ?? [];
}

function presentationSource(cmd: AdvCommand): AdvCommand {
  const source: Record<string, unknown> = {};
  for (const key of [
    "text",
    "textSegments",
    "targetName",
    "targetStatus",
    "targetTextNames",
    "targetTextNamesLocalized",
    "targetTextIDs",
    "targetTextIds",
  ])
    if (cmd[key] !== undefined) source[key] = clonePlain(cmd[key]);
  if (cmd.targets) source.targets = cmd.targets.map(({ name, target }) => ({ name, target }));
  if (cmd.raw) source.raw = { TargetTextIDs: cmd.raw.TargetTextIDs ?? cmd.raw.TargetTextIds };
  return source as AdvCommand;
}

function targetDisplayName(cmd: AdvCommand, runtime: AdvRuntimeConfig, resolve = localizedText): StoryResolvedText {
  if (cmd.targetStatus === 2) return { text: "" };
  if (cmd.targetStatus === 1) return { text: "???" };
  const split = runtime.targetNameSplitKey || "・";
  const commandTextNames = localizedTextEntries(commandTargetTextNames(cmd), resolve);
  if (commandTextNames.length) return joinLocalizedText(commandTextNames, split);
  const names = (cmd.targets || [])
    .map((target) => resolve(target.name || target.target))
    .filter((entry) => Boolean(entry.text));
  return names.length ? joinLocalizedText(names, split) : resolve(cmd.targetName || "");
}

function chatWindowDisplayName(cmd: AdvCommand, runtime: AdvRuntimeConfig, resolve = localizedText): StoryResolvedText {
  const split = runtime.targetNameSplitKey || "・";
  const commandTextNames = localizedTextEntries(commandTargetTextNames(cmd), resolve);
  if (commandTextNames.length) return joinLocalizedText(commandTextNames, split);
  const targetTextNames = localizedTextIds(commandTargetTextIds(cmd), resolve);
  if (targetTextNames.length) return joinLocalizedText(targetTextNames, split);
  return resolve(cmd.text || cmd.targetName || "");
}

function clearTalkState(state: Record<string, unknown>) {
  if (!state?.talk) return;
  const talk = state.talk as Record<string, unknown>;
  talk.visible = false;
  talk.sourceCommand = undefined;
  talk.prefixLength = 0;
  talk.fontScale = 1;
  talk.speaker = "";
  talk.speakerLang = undefined;
  talk.text = "";
  talk.textLang = undefined;
  talk.displayedText = "";
  talk.textFormat = undefined;
  talk.textDisplayMode = undefined;
  talk.targetName = "";
  talk.textComplete = true;
}

function clearSubtitlesState(subtitles: AdvPlayerState["subtitles"]): void {
  delete subtitles.sourceText;
  subtitles.visible = false;
  subtitles.text = "";
  subtitles.lang = undefined;
  subtitles.lastText = "";
  subtitles.lastLang = undefined;
}

function updateSubtitlesState(
  subtitles: AdvPlayerState["subtitles"],
  text: string,
  lang: string | undefined,
  visible: boolean,
): void {
  subtitles.text = text;
  subtitles.lang = lang;
  subtitles.lastText = text;
  subtitles.lastLang = lang;
  subtitles.visible = visible && Boolean(text);
}

function soundFadeSeconds(cmd: AdvCommand) {
  return Math.max(0, finite(param(cmd, 0), 0));
}

function htmlColor(value: unknown, fallback = "#000000") {
  const raw = String(value || "").trim();
  return /^#[0-9a-f]{6,8}$/i.test(raw) ? raw.slice(0, 7) : fallback;
}

function localPlaybackUrl(value: unknown, label: string) {
  const url = String(value || "");
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) throw new Error(`ADV ${label} playback must use local assets, got remote URL: ${url}`);
  return requireCanonicalStoryResourceUrl(url, `${label} playback`);
}

function commandDuration(ctx: AdvCommandContext, cmd: AdvCommand, fallback = 0) {
  return ctx.Model.calcDuration(cmd.duration, fallback);
}

function frameCanvasAlpha(frame: AdvFrameEntry | null) {
  return Math.max(0, Math.min(1, finite(frame?.canvasAlpha, frame?.type === "letterbox" ? 0.8 : 1)));
}

function frameClipDuration(ctx: AdvCommandContext, stateName: string, frame: AdvFrameEntry | null) {
  const lower = String(stateName || "").toLowerCase();
  const clipSeconds = lower.includes("hide") ? finite(frame?.clips?.hide, 0.5) : finite(frame?.clips?.show, 0.5);
  return ctx.Model.calcDuration(clipSeconds, clipSeconds);
}

function frameCommandKey(cmd: AdvCommand, frame: AdvFrameEntry | null = null) {
  return String(cmd?.frameName || cmd?.targetAssetName || frame?.name || frame?.source || "").trim();
}

function ensureFrameStateMap(state: Record<string, unknown>) {
  if (!state.frameEntries || typeof state.frameEntries !== "object") state.frameEntries = {};
  return state.frameEntries as Record<string, { frame: AdvFrameEntry | null; opacity: number; slide: number }>;
}

function activeFrameKeys(state: Record<string, unknown>) {
  const frameEntries = (state.frameEntries || {}) as Record<
    string,
    { frame: AdvFrameEntry | null; opacity: number; slide: number }
  >;
  return Object.keys(frameEntries).filter((key) => finite(frameEntries[key]?.opacity, 0) > 0.001);
}

function chatWindowKey(cmd: AdvCommand) {
  return String(cmd?.targetAssetName || cmd?.targetName || cmd?.chatWindowAssetName || cmd?.targetChatID || "").trim();
}

function chatWindowAssetName(cmd: AdvCommand, runtime: AdvRuntimeConfig) {
  const master = resolveAdvChatMaster(cmd?.targetChatID, runtime);
  return String(cmd?.chatWindowAssetName || master?.chatWindowAssetName || cmd?.targetAssetName || "").trim();
}

function chatIconAssetName(cmd: AdvCommand, runtime: AdvRuntimeConfig, fallback = "") {
  const master = resolveAdvChatMaster(cmd?.targetChatID, runtime);
  return String(cmd?.chatIconAssetName || master?.chatIconAssetName || fallback || "").trim();
}

function chatWindowMemoryId(cmd: AdvCommand, fallback = "") {
  return String(cmd?.chatMemoryId || param(cmd, 2) || cmd?.targetChatID || cmd?.targetName || fallback || "").trim();
}

function chatCommandMemoryId(cmd: AdvCommand, currentMemoryId = "", currentVisible = false) {
  const explicit = String(cmd?.chatMemoryId || param(cmd, 2) || "").trim();
  if (explicit) return explicit;
  const current = String(currentMemoryId || "").trim();
  if (currentVisible && current) return current;
  return String(cmd?.targetChatID || cmd?.targetName || current || "").trim();
}

function commandText(cmd: AdvCommand, fallback = "", resolve = localizedText): StoryResolvedText {
  return resolve(cmd?.text || fallback || "");
}

function chatTypingText(cmd: AdvCommand, resolve = localizedText): StoryResolvedText {
  return commandText(cmd, "", resolve);
}

function isSkipClipTarget(value: unknown) {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase() === "skipcliptarget"
  );
}

function hasAuthoredVideoId(cmd: AdvCommand, source: string) {
  const rawId = cmd.videoId;
  if (rawId == null || String(rawId).trim() === "") return Boolean(source);
  const id = Number(rawId);
  return Number.isFinite(id) ? id > 0 : Boolean(source);
}

function stageEnvPresets(stageValue: unknown, keys: readonly string[]) {
  if (!stageValue || typeof stageValue !== "object") return [];
  const stage = stageValue as Record<string, unknown>;
  for (const key of keys) {
    const presets = stage[key];
    if (Array.isArray(presets)) return presets;
  }
  return [];
}

function hasStageEnvPreset(stageValue: unknown, keys: readonly string[], index: number) {
  if (!Number.isInteger(index) || index < 0) return false;
  const presets = stageEnvPresets(stageValue, keys);
  return index < presets.length && presets[index] != null;
}

function chatParticipantToken(name: unknown) {
  return String(name || "")
    .trim()
    .replace(/^advchat_/i, "")
    .replace(/_\d+$/, "");
}

function chatSenderIsSelf(participants: unknown, senderTargetName: unknown) {
  const parts = String(participants || "");
  const sender = chatParticipantToken(senderTargetName);
  if (!parts || !sender) return false;
  return parts === sender || parts.startsWith(`${sender}_`);
}

function restoreChatMessages(ctx: AdvCommandContext, memoryId: string) {
  return ctx.Session.getOrCreateChatMemoryState(memoryId).entries.map((entry: AdvChatMemoryEntry, index: number) => ({
    id: `restore-${index}`,
    sourceCommand: entry.sourceCommand,
    speaker: entry.senderName,
    speakerLang: entry.senderLang,
    text: entry.text,
    textLang: entry.textLang,
    stamp: entry.entryType === 1 ? entry.stampAssetName : undefined,
    self: entry.self,
    readCount: entry.readCount,
    icon: entry.icon,
    iconAssetName: entry.iconAssetName || entry.icon,
    iconChatId: entry.senderChatId || 0,
  }));
}

function visibleChatMemory(ctx: AdvCommandContext, memoryId: string) {
  const chat = ctx.state.chat;
  return Boolean(
    chat.visible && memoryId && chat.memoryId === memoryId && ctx.Session.CurrentChatMemoryId === memoryId,
  );
}

function beginHideChatWindow(ctx: AdvCommandContext) {
  ctx.state.chat.visible = false;
  ctx.state.chat.typing = "";
  ctx.state.chat.typingLang = undefined;
  ctx.state.chat.readVisible = false;
}

function clearHiddenChatWindowAssets(ctx: AdvCommandContext) {
  ctx.state.chat.windowAssetName = "";
  ctx.state.chat.dataRoot = "";
  ctx.state.chat.iconAssetName = "";
  ctx.state.chat.group = false;
}

function createAbortLink(...parents: Array<AbortSignal | undefined>) {
  const controller = new AbortController();
  const activeParents = parents.filter((parent): parent is AbortSignal => Boolean(parent));
  if (activeParents.some((parent) => parent.aborted)) {
    controller.abort();
  } else if (activeParents.length) {
    const abort = (): void => controller.abort();
    for (const parent of activeParents) parent.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener(
      "abort",
      () => {
        for (const parent of activeParents) parent.removeEventListener("abort", abort);
      },
      { once: true },
    );
    if (activeParents.some((parent) => parent.aborted)) controller.abort();
  }
  return controller;
}

function combineAbortSignals(...parents: Array<AbortSignal | undefined>): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const activeParents = parents.filter((parent): parent is AbortSignal => Boolean(parent));
  let disposed = false;
  const abort = (event: Event): void => {
    const source = event.target as AbortSignal;
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    controller.signal.removeEventListener("abort", dispose);
    for (const parent of activeParents) {
      parent.removeEventListener("abort", abort);
    }
  };
  controller.signal.addEventListener("abort", dispose, { once: true });
  for (const parent of activeParents) {
    if (controller.signal.aborted) break;
    if (parent.aborted && !controller.signal.aborted) {
      controller.abort(parent.reason);
    } else {
      parent.addEventListener("abort", abort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    dispose,
  };
}

function isAudioCommand(command: unknown) {
  return (
    command === ADV_COMMAND.Bgm ||
    command === ADV_COMMAND.SoundVolume ||
    command === ADV_COMMAND.Se ||
    command === ADV_COMMAND.Voice
  );
}

function firstOpeningPlayableBgm(commands: AdvCommand[]) {
  const commandGroups = commands.map((command) => flattenAdvCommands([command]));
  const firstWait = commandGroups.findIndex((group) =>
    group.some((cmd) => [2, 26, 27, 29, 37, 38, 41].includes(Number(cmd?.command))),
  );
  const limit = firstWait >= 0 ? firstWait + 32 : commands.length;
  for (let index = 0; index < commandGroups.length && index <= limit; index += 1) {
    const bgm = commandGroups[index]?.find(
      (cmd) => Number(cmd?.command) === ADV_COMMAND.Bgm && cmd?.bgm?.playableUrl,
    )?.bgm;
    if (bgm) return bgm;
  }
  return null;
}

export class AdvPlayer {
  mount: HTMLElement;
  story: AdvStory;
  state: AdvPlayerState;
  runtime: AdvRuntimeConfig;
  Model: AdvPlayerModel;
  Session: AdvPlaybackSession;
  CommandService: AdvCommandService;
  SceneRoot: StorySceneBackend;
  Loader: AdvEpisodeResourceLoader;
  PlayableDirector: AdvPlayableDirector;
  SoundManager: AdvSoundManager;
  private readonly commandGroupScheduler: AdvCommandGroupScheduler;
  abortController: AbortController;
  autoAdvanceController: AbortController | null;
  autoPlayIntervalSeconds: number;
  autoPlayIntervalIndex: number;
  keyToListIndex: Map<string, number>;
  choiceResolver: ((key: unknown) => void) | null;
  activeSeek: AdvSeekRequest | null;
  private seekGeneration: number;
  private idleSeekDrain: Promise<void> | null = null;
  private playbackCommandController: AbortController | null = null;
  private completedSeekRevision = 0;
  private coverTransitionGeneration: number;
  private readonly motionWaitQueues: Map<string, AdvCharacterMotionQueue>;
  private motionWaitFrame: number | null;
  private motionWaitLastSeconds: number;
  private backgroundDoFCommandController: AbortController | null;
  private readonly characterDoFCommandOwners: Map<number, AdvCharacterDoFCommandOwner>;
  private shakeWaitController: AbortController | null;
  private clipPlaybackController: AbortController | null;
  Context: AdvCommandContext;
  disposed: boolean;
  private bootGeneration: number;
  private readonly detachedCommandTasks: Set<Promise<void>>;
  private readonly extensionOpcodes: Set<number>;
  private readonly replaySafeExtensionOpcodes: Set<number>;
  private seekIndexBuild: AdvSeekIndexBuild | null;
  private seekIndexBuilding: boolean;
  private seekSoundProjection: AdvSoundSnapshot | null;
  private lastSettledSeekBoundary: number;
  private lastSharedCheckpoint: StorySeekCheckpoint | undefined;
  private chatTypingGeneration: number;
  private chatTypingController: { finish: () => void } | null;
  private talkPresentationGeneration: number;
  private manualAdvanceGeneration: number;
  private talkTypingController: { finish: () => void } | null;
  private executionObserver: AdvPlayerExecutionObserver | null;
  private readonly executionObservers: Set<AdvPlayerExecutionObserver>;
  private readonly presentationObservers = new Set<() => void>();
  private presentationNotificationQueued = false;
  private readonly playbackResumeWaiters: Set<() => void>;
  readonly narrativeStore: VegaNarrativeStore;
  readonly resolveLocalizedText: typeof resolveStoryLocalizedText;
  private readonly characterProviders: readonly StoryCharacterProvider[];
  private readonly resources: StoryResourceResolver;
  private textSpeedRate = 1;
  private locale = "auto";
  private restoredDialoguePending = false;
  private disposal: Promise<void> | null = null;
  private disposalReleasesTextures = false;

  constructor({
    mount,
    story,
    state,
    commandExtensions = [],
    sceneBackend,
    resources = new DefaultStoryResourceResolver(),
    narrativeStore = new VegaNarrativeStore(),
    narrativeInput,
    characterProviders = [],
    resourcePreparers = [],
    resolveLocalizedText = resolveStoryLocalizedText,
  }: {
    mount: HTMLElement;
    resolveLocalizedText?: typeof resolveStoryLocalizedText;
    story: AdvStory;
    state: AdvPlayerState;
    commandExtensions?: readonly AdvCommandExtensionRegistration[];
    sceneBackend?: StorySceneBackend;
    resources?: StoryResourceResolver;
    narrativeStore?: VegaNarrativeStore;
    narrativeInput?: VegaNarrativeInputProvider;
    characterProviders?: readonly StoryCharacterProvider[];
    resourcePreparers?: readonly StoryResourcePreparer[];
  }) {
    const bindings = new Map(
      commandExtensions.filter((entry) => entry.commandType).map((entry) => [entry.commandType!, entry.opcode]),
    );
    const bind = (command: AdvCommand): AdvCommand => {
      const output = { ...command };
      const type = typeof command.command === "string" ? command.command : command.commandType;
      if (type !== undefined) {
        if (!isVegaCommandType(type)) throw new TypeError(`Invalid command type: ${String(type)}`);
        const opcode = bindings.get(type);
        if (opcode === undefined) throw new Error(`No plugin provides command ${type}`);
        output.command = opcode;
        output.commandType = type;
      } else if (isVegaExtensionOpcode(command.command))
        throw new TypeError("Plugin commands must use a qualified command type");
      if (command.commandGroup)
        output.commandGroup = {
          ...command.commandGroup,
          actions: command.commandGroup.actions.map((action) => ({ ...action, command: bind(action.command) })),
        };
      if (command.timeline)
        output.timeline = {
          ...command.timeline,
          signals: command.timeline.signals.map((signal) => ({ ...signal, episode: bind(signal.episode) })),
        };
      return output;
    };
    story = { ...story, commands: story.commands?.map(bind) };
    const project = story.vegaProject as { locale?: unknown; locales?: unknown } | undefined;
    const localization = story.localization;
    const localeList = project?.locales ?? localization?.locales;
    const declaredLocales = Array.isArray(localeList)
      ? localeList.filter((value): value is string => typeof value === "string")
      : undefined;
    const arrayOrder = Array.isArray(localization?.arrayOrder)
      ? localization.arrayOrder.filter((value): value is string => typeof value === "string")
      : [];
    const defaultLocale = project?.locale ?? localization?.defaultLocale ?? declaredLocales?.[0];
    const defaultResolver =
      resolveLocalizedText === resolveStoryLocalizedText && typeof defaultLocale === "string"
        ? (value: unknown) => resolveAdvLocale(value, defaultLocale, resolveLocalizedText, arrayOrder)
        : resolveLocalizedText;
    this.resolveLocalizedText = (value) =>
      resolveAdvLocale(
        value,
        declaredLocales &&
          !declaredLocales.some((locale) => canonicalAdvLocale(locale) === canonicalAdvLocale(this.locale))
          ? "auto"
          : this.locale,
        defaultResolver,
        arrayOrder,
      );
    this.mount = mount;
    this.story = story;
    this.state = state;
    this.runtime = mergeAdvRuntime(story?.runtime);
    this.Model = new AdvPlayerModel();
    this.Session = new AdvPlaybackSession(this.runtime);
    this.CommandService = new AdvCommandService();
    this.narrativeStore = narrativeStore;
    this.characterProviders = Object.freeze([...characterProviders]);
    this.resources = resources;
    this.SceneRoot =
      sceneBackend ??
      new GenericStoryScene(this.runtime, state, resources, {
        characterProviders: this.characterProviders,
      });
    this.SoundManager = new AdvSoundManager(
      this.runtime,
      state as AdvPlayerState & {
        session?: { sePlayIds?: number[]; currentVoicePlayIds?: number[] };
      },
      resources,
    );
    this.Loader = new AdvEpisodeResourceLoader(
      this.SceneRoot,
      state,
      resources,
      this.characterProviders,
      this.SoundManager,
      {
        resourcePreparers,
        commandResourcePreparers: commandExtensions,
        resolveLocalizedText: this.resolveLocalizedText,
        document: mount.ownerDocument,
      },
    );
    this.abortController = new AbortController();
    this.autoAdvanceController = null;
    this.autoPlayIntervalSeconds = autoPlayIntervalSeconds(undefined);
    this.autoPlayIntervalIndex = normalizeAutoPlayInterval(undefined);
    this.keyToListIndex = new Map();
    this.choiceResolver = null;
    this.activeSeek = null;
    this.seekGeneration = 0;
    this.coverTransitionGeneration = 0;
    this.motionWaitQueues = new Map();
    this.motionWaitFrame = null;
    this.motionWaitLastSeconds = 0;
    this.backgroundDoFCommandController = null;
    this.characterDoFCommandOwners = new Map();
    this.shakeWaitController = null;
    this.clipPlaybackController = null;
    this.disposed = false;
    this.bootGeneration = 0;
    this.detachedCommandTasks = new Set();
    this.extensionOpcodes = new Set();
    this.replaySafeExtensionOpcodes = new Set();
    this.seekIndexBuild = null;
    this.seekIndexBuilding = false;
    this.seekSoundProjection = null;
    this.lastSettledSeekBoundary = 0;
    this.chatTypingGeneration = 0;
    this.chatTypingController = null;
    this.talkPresentationGeneration = 0;
    this.manualAdvanceGeneration = 0;
    this.talkTypingController = null;
    this.executionObserver = null;
    this.executionObservers = new Set();
    this.playbackResumeWaiters = new Set();
    this.Context = {
      Session: this.Session,
      Model: this.Model,
      Loader: this.Loader,
      SceneRoot: this.SceneRoot,
      SoundManager: this.SoundManager,
      QualityConfig: new AdvQualityConfig(this.runtime?.quality || this.runtime),
      state: this.state,
      runtime: this.runtime,
    };
    this.PlayableDirector = new AdvPlayableDirector({
      executeEpisode: (episode, signal) => {
        const command = interpolateNarrativeCommand(episode, this.narrativeStore);
        if (!matchesNarrativeCommandCondition(command, this.narrativeStore)) return;
        return this.CommandService.executeCommand(
          command.command as number,
          deterministicReplayCommand(command, this.Model.shouldShortCut),
          this.Context,
          signal,
        );
      },
      getPlaybackSpeed: () => this.Model.getCurrentSpeedRate(),
      onBackgroundError: (error) => {
        if (this.disposed) return;
        this.state.error = error instanceof Error ? error.message : String(error);
      },
    });
    this.commandGroupScheduler = new AdvCommandGroupScheduler({
      execute: (command, signal) => this.executeCommandGroupAction(command, signal),
      delay: (seconds, signal) => this.delayWithSpeedAdjustment(seconds, signal),
      onError: (error) => {
        if (!this.disposed) this.state.error = error instanceof Error ? error.message : String(error);
      },
    });
    (this.state as Record<string, unknown>).session = this.Session;
    this.registerCommands();
    for (const registration of createVegaSystemCommands({
      store: this.narrativeStore,
      input: narrativeInput,
      navigateToKey: (key) => {
        this.navigateToKey(key);
      },
      finish: () => {
        this.finish();
      },
    })) {
      this.CommandService.registerCommand(registration.opcode, {
        execute: registration.execute,
      });
    }
    for (const extension of commandExtensions) {
      if (!isVegaExtensionOpcode(extension.opcode))
        throw new RangeError(`Plugin execution slot overlaps a built-in opcode: ${extension.opcode}`);
      this.extensionOpcodes.add(extension.opcode);
      if (extension.replaySafe === true) {
        this.replaySafeExtensionOpcodes.add(extension.opcode);
      }
      this.CommandService.registerCommand(extension.opcode, {
        execute: (command, context, signal) =>
          this.runCommandTask(command, () => extension.execute(command, context, signal)),
      });
    }
  }

  private executeCommandGroupAction(command: AdvCommand, signal: AbortSignal): Promise<void> | void {
    const interpolated = interpolateNarrativeCommand(command, this.narrativeStore);
    if (!matchesNarrativeCommandCondition(interpolated, this.narrativeStore)) return;
    if (interpolated.ignoreData && !isAudioCommand(interpolated.command)) return;
    if (this.disposed || signal.aborted) return;
    return this.CommandService.executeCommand(
      interpolated.command as number,
      deterministicReplayCommand(interpolated, this.Model.shouldShortCut),
      this.Context,
      signal,
    );
  }

  async boot(options: { skipPreload?: boolean; signal?: AbortSignal } = {}) {
    const linked = combineAbortSignals(this.abortController.signal, options.signal);
    const signal = linked.signal;
    try {
      if (this.disposed || signal.aborted) return;
      const generation = ++this.bootGeneration;
      const isActive = () => !this.disposed && !signal.aborted && generation === this.bootGeneration;
      const skipPreload = options.skipPreload === true;
      this.state.loading = !skipPreload;
      this.state.error = "";
      this.state.commandCount = this.story?.commands?.length || 0;
      if (!skipPreload) {
        this.state.preload = {
          done: 0,
          total: 0,
          label: "scene index",
          failures: [],
        };
      }
      this.indexEpisodeKeys();
      await prepareStoryCharacterProviders(this.characterProviders, this.story, this.resources, signal);
      if (!isActive()) return;
      await this.SceneRoot.prepare?.(this.story);
      if (!isActive()) return;
      await this.SceneRoot.setup(this.mount);
      if (!isActive()) return;
      if (skipPreload) {
        this.state.preload = { done: 0, total: 0, label: "", failures: [] };
      } else {
        await this.Loader.preload(this.story, signal);
        if (!isActive()) return;
      }
      if (!isActive()) return;
      this.warmOpeningBgm();
      const initialSeekIndex = this.seekIndexFor(new Map<number, AdvChoiceRecord>());
      initialSeekIndex.checkpoints.clear();
      initialSeekIndex.boundaries.length = 0;
      initialSeekIndex.complete = false;
      initialSeekIndex.blockedAt = null;
      initialSeekIndex.blockedReason = "";
      if (!this.captureCheckpoint(0, true)) {
        throw new Error("The scene renderer could not capture its initial seek state");
      }
      if (!skipPreload) {
        // Resource work has its own determinate counter. Building exact
        // command-boundary snapshots is CPU work rather than another resource
        // catalogue, so keep this second phase indeterminate while retaining
        // its cooperative 16-command yields below.
        this.state.preload.done = 0;
        this.state.preload.total = 0;
        this.state.preload.label = "scene index";
        const decisions = new Map<number, AdvChoiceRecord>();
        await this.ensureSeekIndex(decisions, { trackLoadingProgress: true });
        if (!isActive()) return;
        const initial = this.seekIndexFor(decisions).checkpoints.get(0) as StorySeekCheckpoint | undefined;
        if (!initial) throw new Error("The scene index is missing command boundary 0");
        await this.applyCheckpoint(initial, decisions);
        this.finishSeekRestoration(0);
      }
      this.state.loading = false;
      this.state.ready = true;
    } finally {
      // Loader owns its own episode controller after preload completes. Only
      // detach the temporary parent listeners here; aborting this composite on
      // success would incorrectly release the episode's animation leases.
      linked.dispose();
    }
  }

  warmOpeningBgm() {
    const bgm = firstOpeningPlayableBgm(this.story?.commands || []);
    if (bgm) this.SoundManager.warmSound(bgm, "Bgm");
  }

  executeCommandAtIndex(commands: AdvCommand[], index: number, signal: AbortSignal): Promise<void> | void {
    const authoredCommand = commands[index];
    const cmd = authoredCommand ? interpolateNarrativeCommand(authoredCommand, this.narrativeStore) : authoredCommand;
    this.Loader.advanceTo(index);
    this.state.commandIndex = index + 1;
    this.state.currentCommand = cmd;
    this.Model.CurrentEpisodeListIndex = index + 1;
    if (!cmd) return;
    if (!matchesNarrativeCommandCondition(cmd, this.narrativeStore)) return;
    if (cmd.ignoreData && !isAudioCommand(cmd.command)) return;
    if (this.seekIndexBuilding && this.seekSoundProjection) {
      this.seekSoundProjection.frameStamp += 1;
    } else {
      this.SoundManager.advanceFrame();
    }
    if (this.disposed || signal.aborted) return;
    return this.CommandService.executeCommand(
      cmd.command as number,
      deterministicReplayCommand(cmd, this.Model.shouldShortCut),
      this.Context,
      signal,
    );
  }

  /**
   * Installs a command-boundary observer for editor/debug adapters. Playback
   * semantics remain owned by AdvPlayer; adapters never patch the interpreter.
   */
  setExecutionObserver(observer: AdvPlayerExecutionObserver | null): void {
    this.executionObserver = observer;
  }

  /**
   * Adds an independent command-boundary observer. The returned disposer is
   * idempotent, so shells, preview adapters, and plugins cannot replace one
   * another's subscriptions.
   */
  subscribeExecutionObserver(observer: AdvPlayerExecutionObserver): () => void {
    this.executionObservers.add(observer);
    return () => {
      this.executionObservers.delete(observer);
    };
  }

  subscribePresentationObserver(observer: () => void): () => void {
    this.presentationObservers.add(observer);
    return () => {
      this.presentationObservers.delete(observer);
    };
  }

  /**
   * Executes an editor snippet against the current scene and narrative store
   * without replacing the loaded story or moving its playback cursor.
   */
  async executePreviewCommands(commands: readonly AdvCommand[], signal?: AbortSignal): Promise<void> {
    if (this.disposed || this.abortController.signal.aborted) {
      throw new ReferenceError("Cannot execute a preview snippet on a disposed player");
    }
    if (this.state.playing || this.state.seeking) {
      throw new Error("Pause scene playback before executing a preview snippet");
    }
    const controller = createAbortLink(this.abortController.signal, signal);
    const previousCommand = this.state.currentCommand;
    const previousCommandIndex = this.state.commandIndex;
    const previousModelIndex = this.Model.CurrentEpisodeListIndex;
    try {
      for (const authoredCommand of commands) {
        if (controller.signal.aborted) break;
        const command = interpolateNarrativeCommand(authoredCommand, this.narrativeStore);
        this.state.currentCommand = command;
        if (!matchesNarrativeCommandCondition(command, this.narrativeStore)) continue;
        this.SoundManager.advanceFrame();
        const execution = this.CommandService.executeCommand(
          command.command as number,
          deterministicReplayCommand(command, false),
          this.Context,
          controller.signal,
        );
        if (execution) await execution;
      }
      await this.commandGroupScheduler.waitForIdle(controller.signal);
    } finally {
      controller.abort();
      this.state.currentCommand = previousCommand;
      this.state.commandIndex = previousCommandIndex;
      this.Model.CurrentEpisodeListIndex = previousModelIndex;
    }
  }

  private seekIndexFor(decisions: ReadonlyMap<number, AdvChoiceRecord>): AdvSeekCheckpointIndex {
    const signature = seekDecisionSignature(decisions);
    const index = sharedCheckpointIndexFor(this.story, signature, this);
    if (
      signature !== "[]" &&
      !this.seekIndexBuilding &&
      index.boundaries.length === 0 &&
      index.checkpoints.size === 0
    ) {
      const prefix = sharedCheckpointIndexFor(this.story, "[]", this);
      for (const boundary of prefix.boundaries) {
        const checkpoint = prefix.checkpoints.get(boundary);
        if (!checkpoint) continue;
        index.boundaries.push(boundary);
        index.checkpoints.set(boundary, checkpoint);
      }
    }
    return index;
  }

  /** Reachable command boundaries in traversal order for the active path. */
  reachableSeekBoundaries(): readonly number[] {
    return [...this.seekIndexFor(this.Session.choiceRecords).boundaries];
  }

  /** Resolve a normalized timeline position without executing story commands. */
  resolveSeekRatio(ratio: number): number {
    const boundaries = this.seekIndexFor(this.Session.choiceRecords).boundaries;
    if (!boundaries.length) return 0;
    const ordinal = Math.round(clamp01(ratio) * Math.max(0, boundaries.length - 1));
    return boundaries[ordinal] ?? boundaries[boundaries.length - 1] ?? 0;
  }

  /** Current position using the same reachable-path timeline as seek release. */
  currentSeekProgress(): {
    readonly ratio: number;
    readonly label: string;
    readonly ordinal: number;
    readonly maximum: number;
  } {
    const boundaries = this.seekIndexFor(this.Session.choiceRecords).boundaries;
    const maximum = Math.max(0, boundaries.length - 1);
    let ordinal = boundaries.lastIndexOf(this.currentProgressIndex());
    if (ordinal < 0) {
      ordinal = boundaries.lastIndexOf(this.lastSettledSeekBoundary);
    }
    if (ordinal < 0) ordinal = 0;
    ordinal = Math.max(0, Math.min(maximum, ordinal));
    return {
      ratio: maximum > 0 ? ordinal / maximum : 0,
      label: this.state.commandCount ? `${ordinal} / ${maximum}` : "",
      ordinal,
      maximum,
    };
  }

  private captureSeekPlayerState(): AdvPlayerSeekStateSnapshot {
    const presentation = Object.fromEntries(
      SEEK_PLAYER_STATE_KEYS.map((key) => [key, clonePlain(this.state[key])]),
    ) as Pick<AdvPlayerState, AdvPlayerSeekStateKey>;
    return {
      presentation,
      narrative: this.narrativeStore.snapshot(),
      model: {
        forcedAutoPlay: this.Model.forcedAutoPlay,
      },
    };
  }

  private restoreSeekPlayerState(snapshot: AdvPlayerSeekStateSnapshot, preservePersistentNarrative: boolean): void {
    const mutableState = this.state as unknown as Record<string, unknown>;
    for (const key of SEEK_PLAYER_STATE_KEYS) {
      mutableState[key] = clonePlain(snapshot.presentation[key]);
    }
    const persistent = preservePersistentNarrative ? this.narrativeStore.snapshot() : null;
    const narrative = snapshot.narrative;
    this.narrativeStore.restore(
      persistent
        ? {
            ...narrative,
            readCommands: [...new Set([...narrative.readCommands, ...persistent.readCommands])],
            visitedFlowNodes: [...new Set([...narrative.visitedFlowNodes, ...persistent.visitedFlowNodes])],
            unlocks: {
              cg: [...new Set([...narrative.unlocks.cg, ...persistent.unlocks.cg])],
              bgm: [...new Set([...narrative.unlocks.bgm, ...persistent.unlocks.bgm])],
              scene: [...new Set([...narrative.unlocks.scene, ...persistent.unlocks.scene])],
              achievement: [...new Set([...narrative.unlocks.achievement, ...persistent.unlocks.achievement])],
            },
            backlog: persistent.backlog,
            settings: persistent.settings,
          }
        : narrative,
    );
    this.Model.forcedAutoPlay = Boolean(snapshot.model?.forcedAutoPlay);
    this.state.autoPlay = this.Model.isAutoEnabled;
    this.state.talkLog = [...this.Session.TalkLog];
    this.refreshLocalizedPresentation();
  }

  private checkpointSoundSnapshot(): AdvSoundSnapshot {
    return clonePlain(
      this.seekIndexBuilding && this.seekSoundProjection
        ? this.seekSoundProjection
        : this.SoundManager.createSnapshot(),
    );
  }

  private seekChoice(cmd: AdvCommand): { decisionIndex: number; choice: AdvChoiceItem } | null {
    const choiceIndex = choiceInteger(param(cmd, 0), "choiceIndex");
    const decisionIndex = Number.isSafeInteger(Number(cmd.index)) ? Number(cmd.index) : choiceIndex;
    const recorded = this.Session.choiceRecords.get(decisionIndex);
    if (!recorded) return null;
    const choice = choiceItems(cmd, choiceIndex, this.narrativeStore.variables, this.resolveLocalizedText).find(
      (item) => seekDecisionEqual(item.record, recorded),
    );
    return choice ? { decisionIndex, choice } : null;
  }

  private seekCompilationBarrier(authored: AdvCommand): string {
    const cmd = interpolateNarrativeCommand(authored, this.narrativeStore);
    if (!matchesNarrativeCommandCondition(cmd, this.narrativeStore)) return "";
    if (cmd.ignoreData && !isAudioCommand(cmd.command)) return "";
    const opcode = Number(cmd.command);
    if (opcode === VEGA_SYSTEM_OPCODE.Input) return "unresolved-input";
    if (opcode === ADV_COMMAND.ChoiceShow && !this.seekChoice(cmd)) {
      return "unresolved-choice";
    }
    if (this.extensionOpcodes.has(opcode) && !this.replaySafeExtensionOpcodes.has(opcode)) {
      return `plugin-not-replay-safe:${opcode}`;
    }
    return "";
  }

  private updateSeekIndexLoadingProgress(processed: number): void {
    const preload = this.state.preload as Record<string, unknown>;
    preload.label = "scene index";
    if (processed > 0) {
      preload.done = Math.min(Number(preload.total) || 0, (Number(preload.done) || 0) + processed);
    }
  }

  private async compileSeekIndex(
    decisions: ReadonlyMap<number, AdvChoiceRecord>,
    options: { trackLoadingProgress?: boolean } = {},
  ): Promise<AdvSeekCheckpointIndex> {
    const commands = this.story?.commands || [];
    const signature = seekDecisionSignature(decisions);
    const index = sharedCheckpointIndexFor(this.story, signature, this);
    const baseIndex = sharedCheckpointIndexFor(this.story, "[]", this);
    const anchor = baseIndex.checkpoints.get(0) as StorySeekCheckpoint | undefined;
    if (!anchor) throw new Error("Cannot compile a scene index without checkpoint 0");
    const returnBoundary = this.currentProgressIndex();
    if (!index.checkpoints.has(returnBoundary) && !this.captureCheckpoint(returnBoundary, true)) {
      throw new Error(`The scene renderer rejected return boundary ${returnBoundary}`);
    }
    const returnCheckpoint = index.checkpoints.get(returnBoundary) as StorySeekCheckpoint | undefined;
    if (!returnCheckpoint) {
      throw new Error(`The scene index is missing return boundary ${returnBoundary}`);
    }

    const loadingBudget = options.trackLoadingProgress ? commands.length : 0;
    let loadingProcessed = 0;
    const advanceLoading = (count = 1): void => {
      if (!loadingBudget || count <= 0) return;
      const next = Math.min(count, loadingBudget - loadingProcessed);
      loadingProcessed += next;
      this.updateSeekIndexLoadingProgress(next);
    };

    index.checkpoints.clear();
    index.boundaries.length = 0;
    index.complete = false;
    index.blockedAt = null;
    index.blockedReason = "";

    await this.applyCheckpoint(anchor, decisions, {
      restoreAudio: false,
      preservePersistentNarrative: false,
    });
    this.SoundManager.suspendForSeek();
    this.seekSoundProjection = clonePlain(anchor.sound);
    this.seekIndexBuilding = true;
    this.SceneRoot.setSeekIndexCompilationActive?.(true);
    this.Model.shouldShortCut = true;
    this.Model.shortCutIndex = commands.length;
    this.state.seeking = true;
    this.SceneRoot.setDeterministicReplayActive(true);
    this.Model.CurrentEpisodeListIndex = 0;
    this.state.commandIndex = 0;
    this.state.currentCommand = commands[0] || null;

    let failure: unknown = null;
    try {
      if (!commands.length) {
        await this.SceneRoot.clearCommandPostEffects(0);
        this.state.finished = true;
        this.retainFinishedRenderState();
      }
      if (!this.captureCheckpoint(0, true)) {
        throw new Error("The scene renderer rejected command boundary 0");
      }
      const visited = new Set<number>();
      let batch = 0;
      while (!this.abortController.signal.aborted && this.Model.CurrentEpisodeListIndex < commands.length) {
        const commandIndex = this.Model.CurrentEpisodeListIndex;
        if (visited.has(commandIndex)) {
          index.blockedAt = commandIndex;
          index.blockedReason = "control-flow-cycle";
          break;
        }
        visited.add(commandIndex);
        const authored = commands[commandIndex];
        if (!authored) {
          index.blockedAt = commandIndex;
          index.blockedReason = "missing-command";
          break;
        }
        const barrier = this.seekCompilationBarrier(authored);
        if (barrier) {
          index.blockedAt = commandIndex;
          index.blockedReason = barrier;
          break;
        }
        const execution = this.executeCommandAtIndex(commands, commandIndex, this.abortController.signal);
        if (execution) await execution;
        await this.settleDetachedCommandTasks();
        await this.SceneRoot.settleSeekSnapshotResources();
        const boundary = this.currentProgressIndex();
        if (boundary >= commands.length) {
          await this.SceneRoot.clearCommandPostEffects(0);
          this.state.finished = true;
          this.retainFinishedRenderState();
        }
        if (!this.captureCheckpoint(boundary, true)) {
          throw new Error(`The scene renderer rejected command boundary ${boundary}`);
        }
        advanceLoading();
        batch += 1;
        if (options.trackLoadingProgress && batch >= 16) {
          batch = 0;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      if (this.Model.CurrentEpisodeListIndex >= commands.length) {
        index.complete = true;
        index.blockedAt = null;
        index.blockedReason = "";
      }
      return index;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      advanceLoading(loadingBudget - loadingProcessed);
      this.seekIndexBuilding = false;
      this.SceneRoot.setSeekIndexCompilationActive?.(false);
      this.seekSoundProjection = null;
      try {
        await this.applyCheckpoint(returnCheckpoint, decisions, {
          preservePersistentNarrative: false,
        });
      } catch (restoreError) {
        if (!failure) throw restoreError;
      } finally {
        this.finishSeekRestoration(returnCheckpoint.index);
      }
    }
  }

  private async ensureSeekIndex(
    decisions: ReadonlyMap<number, AdvChoiceRecord>,
    options: { trackLoadingProgress?: boolean } = {},
  ): Promise<AdvSeekCheckpointIndex> {
    const signature = seekDecisionSignature(decisions);
    const existing = sharedCheckpointIndexFor(this.story, signature, this);
    if (existing.complete || existing.blockedAt != null) {
      if (options.trackLoadingProgress) {
        this.updateSeekIndexLoadingProgress(this.story?.commands?.length || 0);
      }
      return existing;
    }
    if (this.seekIndexBuild) {
      if (this.seekIndexBuild.signature === signature) return this.seekIndexBuild.promise;
      await this.seekIndexBuild.promise;
      return this.ensureSeekIndex(decisions, options);
    }
    const promise = this.compileSeekIndex(decisions, options);
    const build = { signature, promise };
    this.seekIndexBuild = build;
    try {
      return await promise;
    } finally {
      if (this.seekIndexBuild === build) this.seekIndexBuild = null;
    }
  }

  private captureCheckpoint(index = this.currentProgressIndex(), force = false): boolean {
    const commands = this.story?.commands || [];
    const key = Math.max(0, Math.min(commands.length, Math.floor(Number(index) || 0)));
    if (this.disposed || this.abortController.signal.aborted) return false;
    const decisionIndex = this.seekIndexFor(this.Session.choiceRecords);
    if (!force && decisionIndex.complete && decisionIndex.checkpoints.has(key)) {
      this.lastSettledSeekBoundary = key;
      return true;
    }
    if (!force) {
      if (this.choiceResolver || this.Model.waitingNext) return false;
      if (
        this.detachedCommandTasks.size ||
        this.PlayableDirector.hasBackgroundTasks ||
        this.commandGroupScheduler.hasPendingWork
      )
        return false;
      if (this.motionWaitQueues.size) return false;
      if (!this.SoundManager.isSeekSnapshotSafe) return false;
    }
    const scene = this.SceneRoot.createSeekSnapshot();
    if (!scene) return false;
    const checkpoint = shareSeekSnapshot<StorySeekCheckpoint>(this.lastSharedCheckpoint, {
      version: ADV_SEEK_CHECKPOINT_VERSION,
      index: key,
      commandCount: commands.length,
      scene,
      session: this.Session.createSnapshot(),
      loader: this.Loader.createSnapshot(),
      sound: this.checkpointSoundSnapshot(),
      state: this.captureSeekPlayerState(),
    });
    this.lastSharedCheckpoint = checkpoint;
    const newBoundary = !decisionIndex.checkpoints.has(key);
    decisionIndex.checkpoints.set(key, checkpoint);
    if (newBoundary) decisionIndex.boundaries.push(key);
    this.lastSettledSeekBoundary = key;
    return true;
  }

  private maybeCaptureCheckpoint(command: AdvCommand | undefined, index: number): void {
    if (!command) return;
    if (this.seekIndexFor(this.Session.choiceRecords).checkpoints.has(index)) {
      return;
    }
    this.captureCheckpoint(index);
  }

  private async applyCheckpoint(
    checkpoint: StorySeekCheckpoint,
    decisionOverrides: ReadonlyMap<number, AdvChoiceRecord>,
    options: {
      restoreAudio?: boolean;
      preservePersistentNarrative?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<number> {
    this.restoredDialoguePending = false;
    this.cancelAutoAdvance();
    this.commandGroupScheduler.cancelAll();
    await this.commandGroupScheduler.waitForSettled();
    if (this.disposed || options.signal?.aborted) return checkpoint.index;
    this.beginTalkPresentation();
    this.Session.cancelVoicePlaybackScope();
    this.cancelMotionWaitTasks();
    this.cancelDoFCommandOwners();
    this.cancelShakeWait();
    this.Session.DelayTokens.reset();
    this.Model.currentTypingController?.finish();
    this.Model.currentTypingController = null;
    this.cancelChatTyping();
    this.choiceResolver = null;
    this.state.seeking = true;
    this.SceneRoot.setDeterministicReplayActive(true);
    this.SoundManager.suspendForSeek();
    this.Session.restoreSnapshot(checkpoint.session);
    this.Session.choiceRecords.clear();
    for (const [key, value] of decisionOverrides) this.Session.choiceRecords.set(key, value);
    this.Loader.restoreSnapshot(checkpoint.loader);
    await this.SceneRoot.restoreSeekSnapshot(checkpoint.scene, options.signal);
    if (this.disposed || options.signal?.aborted) return checkpoint.index;
    if (options.restoreAudio !== false) this.SoundManager.restoreSnapshot(checkpoint.sound);
    this.restoreSeekPlayerState(checkpoint.state, options.preservePersistentNarrative !== false);
    this.state.paused = false;
    this.Model.isPause = false;
    this.Model.changeIdleState();
    this.Model.CurrentEpisodeListIndex = checkpoint.index;
    this.state.commandIndex = checkpoint.index;
    this.state.currentCommand = this.story.commands?.[checkpoint.index] || null;
    this.Loader.advanceTo(checkpoint.index);
    this.lastSettledSeekBoundary = checkpoint.index;
    return checkpoint.index;
  }

  private finishSeekRestoration(targetIndex: number, paused = false): void {
    const commands = this.story?.commands || [];
    const target = Math.max(0, Math.min(commands.length, Math.floor(Number(targetIndex) || 0)));
    this.Model.CurrentEpisodeListIndex = target;
    this.state.commandIndex = target;
    this.state.currentCommand = commands[target] || null;
    this.Loader.advanceTo(target);
    this.lastSettledSeekBoundary = target;
    this.Model.shouldShortCut = false;
    this.Model.shortCutIndex = -1;
    this.Model.isPause = paused;
    this.state.paused = paused;
    this.state.seeking = false;
    this.completedSeekRevision += 1;
    try {
      this.SceneRoot.presentSeekSnapshot?.();
    } finally {
      this.SceneRoot.setDeterministicReplayActive(false);
      this.cancelAutoAdvance();
      this.Model.changeIdleState();
    }
    if (!this.presentationNotificationQueued) {
      this.presentationNotificationQueued = true;
      queueMicrotask(() => {
        this.presentationNotificationQueued = false;
        if (this.disposed || this.state.seeking) return;
        for (const observer of [...this.presentationObservers]) {
          try {
            observer();
          } catch (error) {
            console.error("[Vega] presentation observer failed", error);
          }
        }
      });
    }
  }

  private async restoreExactSeekTarget(
    targetIndex: number,
    decisions = new Map(this.Session.choiceRecords),
    signal?: AbortSignal,
  ): Promise<number> {
    const commands = this.story?.commands || [];
    const target = Math.max(0, Math.min(commands.length, Math.floor(Number(targetIndex) || 0)));
    const index = this.seekIndexFor(decisions);
    const checkpoint = index.checkpoints.get(target) as StorySeekCheckpoint | undefined;
    if (!checkpoint) {
      const suffix =
        index.blockedAt == null
          ? "is unreachable on the selected decision path"
          : `cannot be indexed past ${index.blockedAt} (${index.blockedReason})`;
      throw new RangeError(`Scene boundary ${target} ${suffix}`);
    }
    if (this.disposed || signal?.aborted) return target;
    await this.applyCheckpoint(checkpoint, decisions, { signal });
    return target;
  }

  /** Restore an already indexed command boundary without executing its prefix. */
  async replayFromStartTo(targetIndex: number) {
    await this.seekTo(targetIndex, { resume: false, force: true });
  }

  get seekRevision(): number {
    return this.completedSeekRevision;
  }

  currentProgressIndex() {
    const commands = this.story?.commands || [];
    return Math.max(0, Math.min(commands.length, Math.floor(Number(this.Model.CurrentEpisodeListIndex) || 0)));
  }

  exportSeekDecisions(): Map<number, AdvChoiceRecord> {
    return new Map(this.Session.choiceRecords);
  }

  importSeekDecisions(decisions?: ReadonlyMap<number, AdvChoiceRecord> | null): void {
    this.Session.choiceRecords = new Map(decisions || []);
  }

  private observeDetachedCommandTask(task: Promise<unknown>): void {
    const observed = task.then(
      () => undefined,
      () => undefined,
    );
    this.detachedCommandTasks.add(observed);
    void observed.finally(() => this.detachedCommandTasks.delete(observed));
  }

  private startDetachedCommandTask(task: () => Promise<unknown> | void): void {
    let pending: Promise<unknown>;
    try {
      // UniTask's async method starts synchronously and only the returned task
      // is passed to Forget(). Preserve that ordering: presentation state set
      // before the helper's first await must be visible to the next command.
      pending = Promise.resolve(task());
    } catch (error) {
      pending = Promise.reject(error);
    }
    this.observeDetachedCommandTask(pending);
  }

  private runCommandTask(cmd: AdvCommand, task: () => Promise<unknown> | void): Promise<void> | void {
    if (cmd.noWait && !this.Model.shouldShortCut) {
      this.startDetachedCommandTask(task);
      return;
    }
    const result = task();
    if (result) return Promise.resolve(result).then(() => undefined);
  }

  /**
   * Native camera commands refresh an independent CTS before entering their
   * shared DelaySeconds gate. A replacement cancels both that delay and the
   * eventual tween without affecting other camera command channels.
   */
  private runTransitionCommandTask(
    cmd: AdvCommand,
    channel: AdvCommandTransitionChannel,
    task: (signal: AbortSignal) => Promise<unknown> | void,
    signal = this.abortController.signal,
  ): Promise<void> | void {
    const transitionSignal = this.Session.DelayTokens.refreshTransition(channel, signal);
    const delay = this.Model.shouldShortCut ? 0 : this.Model.calcDuration(finite(cmd.delaySeconds, 0), 0);
    return this.runCommandTask(cmd, async () => {
      try {
        if (delay > 0) {
          const completed = await this.Session.DelayTokens.delay(delay, transitionSignal);
          if (!completed) return;
        }
        if (this.disposed || transitionSignal.aborted) return;
        await task(transitionSignal);
      } finally {
        this.Session.DelayTokens.releaseTransition(channel, transitionSignal);
      }
    });
  }

  /**
   * Angle/Look/LookTarget run a synchronous preparation segment before their
   * shared cancellable DelaySeconds await. The returned continuation owns the
   * token refresh and tween that are skipped when CancelDelay wins the gate.
   */
  private runPreparedDelayedCommandTask(
    cmd: AdvCommand,
    prepare: () => (() => Promise<unknown> | void) | null,
    signal = this.abortController.signal,
  ): Promise<void> | void {
    const delay = this.Model.shouldShortCut ? 0 : this.Model.calcDuration(finite(cmd.delaySeconds, 0), 0);
    return this.runCommandTask(cmd, async () => {
      const commit = prepare();
      if (!commit) return;
      if (delay > 0) {
        const completed = await this.Session.DelayTokens.delay(delay, signal);
        if (!completed || this.disposed || signal.aborted) return;
      }
      await commit();
    });
  }

  private async settleDetachedCommandTasks(): Promise<void> {
    await this.commandGroupScheduler.waitForSettled(this.abortController.signal);
    while (this.detachedCommandTasks.size) {
      await Promise.all([...this.detachedCommandTasks]);
    }
    await this.PlayableDirector.waitForBackgroundTasks();
    while (this.detachedCommandTasks.size) {
      await Promise.all([...this.detachedCommandTasks]);
    }
    await this.commandGroupScheduler.waitForSettled(this.abortController.signal);
  }

  /** Restore an indexed boundary while retaining renderer/controller caches. */
  async seekTo(targetIndex: number, options: { resume?: boolean; force?: boolean } = {}) {
    if (this.disposed || this.abortController.signal.aborted) return;
    const commands = this.story?.commands || [];
    const target = Math.max(0, Math.min(commands.length, Math.floor(Number(targetIndex) || 0)));
    const start = this.currentProgressIndex();
    if (!this.seekIndexFor(this.Session.choiceRecords).checkpoints.has(target)) {
      throw new RangeError(`Scene boundary ${target} is not prepared on the selected decision path`);
    }
    const paused = this.activeSeek?.paused ?? (this.Model.isPause || this.state.paused);
    const resume = options.resume ?? this.activeSeek?.resume ?? (this.state.playing && !paused);
    const previousSeek = this.activeSeek;
    if (previousSeek && previousSeek.target === target && !options.force) {
      previousSeek.resume = resume;
      await previousSeek.completion;
      return;
    }
    previousSeek?.controller.abort();
    const controller = createAbortLink(this.abortController.signal);
    let resolve = previousSeek?.resolve ?? (() => {});
    let reject = previousSeek?.reject ?? ((_error?: unknown) => {});
    const completion =
      previousSeek?.completion ??
      new Promise<void>((done, failed) => {
        resolve = done;
        reject = failed;
      });
    this.activeSeek = {
      generation: ++this.seekGeneration,
      target,
      paused,
      resume,
      controller,
      completion,
      resolve,
      reject,
    };
    this.cancelAutoAdvance();
    this.state.seeking = true;
    this.Model.shouldShortCut = true;
    this.Model.shortCutIndex = target;
    this.unblockForSeek();
    if (!this.state.playing) {
      if (!this.idleSeekDrain) {
        this.idleSeekDrain = Promise.resolve().then(async () => {
          try {
            await this.reconcileActiveSeekCheckpoint();
            this.maybeFinishActiveSeek(commands);
          } catch {
            // The request's completion promise carries the restoration error.
          } finally {
            this.idleSeekDrain = null;
          }
        });
      }
    } else {
      this.Model.isPause = false;
      this.state.paused = false;
      this.releasePlaybackResumeWaiters();
    }
    await completion;
  }

  /**
   * Replace the destination of an in-flight playback seek without waiting for
   * the abandoned destination. Progress sliders can emit another committed
   * value while the previous scene snapshot is still restoring;
   * keeping the original waiter attached to the new request lets that one
   * operation finish only after the latest destination is coherent.
   */
  retargetActiveSeek(targetIndex: number): boolean {
    const request = this.activeSeek;
    if (!request) return false;
    const commands = this.story?.commands || [];
    const target = Math.max(0, Math.min(commands.length, Math.floor(Number(targetIndex) || 0)));
    if (target === request.target) return true;
    this.cancelAutoAdvance();
    this.state.seeking = true;
    this.Model.shouldShortCut = true;
    this.Model.shortCutIndex = target;
    request.controller.abort();
    if (this.state.playing) this.unblockForSeek();
    this.activeSeek = {
      ...request,
      generation: ++this.seekGeneration,
      target,
      controller: createAbortLink(this.abortController.signal),
    };
    return true;
  }

  async seekForwardTo(targetIndex: number) {
    const commands = this.story?.commands || [];
    const target = Math.max(0, Math.min(commands.length, Math.floor(Number(targetIndex) || 0)));
    if (target <= this.currentProgressIndex()) return;
    await this.seekTo(target);
  }

  /**
   * A progress drag may replace the active target while an asynchronous scene
   * snapshot is being restored. Reconcile against the request object captured
   * before each await; a superseded restore must never be allowed to finish a
   * newer, earlier target with its later visual state still mounted.
   */
  private async reconcileActiveSeekCheckpoint(): Promise<void> {
    while (this.activeSeek) {
      const request = this.activeSeek;
      try {
        await this.restoreExactSeekTarget(request.target, undefined, request.controller.signal);
      } catch (error) {
        if (this.disposed) return;
        if (this.activeSeek !== request) continue;
        if (this.activeSeek === request) {
          this.activeSeek = null;
          request.reject(error);
          try {
            this.finishSeekRestoration(this.currentProgressIndex(), request.paused);
          } finally {
            request.controller.abort();
          }
        }
        throw error;
      }

      if (this.disposed) return;

      if (this.activeSeek !== request || this.activeSeek.generation !== request.generation) {
        continue;
      }
      return;
    }
  }

  unblockForSeek() {
    this.playbackCommandController?.abort();
    this.SceneRoot.setDeterministicReplayActive(true);
    this.SceneRoot.cancelTransitionsForSeek?.();
    this.cancelAutoAdvance();
    this.commandGroupScheduler.cancelAll();
    this.beginTalkPresentation();
    this.Session.cancelVoicePlaybackScope();
    this.Session.DelayTokens.reset();
    if (this.choiceResolver) this.choose(ABORTED_CHOICE);
    if (this.SceneRoot.skipVideo()) {
      this.Session.FlowParameters?.setClipSkip?.(true);
      this.Session.FlowParameters?.setClipVideoPlaying?.(false);
      this.Session.VideoPlaying = false;
      this.SceneRoot.hideVideo(0).catch(() => {});
    }
    this.Model.currentTypingController?.finish();
    this.Model.currentTypingController = null;
    this.cancelChatTyping();
    this.Model.changeGoNextState();
    this.SoundManager.stopTransientForSeek();
    this.SceneRoot.stopAllTimedPseudoLipSync();
    this.SceneRoot.stopAllSpeaking();
  }

  private enqueueWaitingMotion(target: string, identity: string, waitSeconds: number, play: () => void): void {
    const waiting: AdvWaitingMotion = {
      remainingSeconds: Math.max(0, finite(waitSeconds)),
      identity,
      play,
    };
    const queue = this.motionWaitQueues.get(target);
    if (queue) queue.queued.push(waiting);
    else this.motionWaitQueues.set(target, { current: waiting, queued: [] });
    this.scheduleMotionWaitFrame();
  }

  private scheduleMotionWaitFrame(): void {
    if (this.motionWaitFrame != null || !this.motionWaitQueues.size || this.disposed) return;
    if (this.motionWaitLastSeconds <= 0) this.motionWaitLastSeconds = nowSeconds();
    this.motionWaitFrame = requestAnimationFrame(this.updateWaitingMotions);
  }

  private readonly updateWaitingMotions = (): void => {
    this.motionWaitFrame = null;
    if (this.disposed || !this.motionWaitQueues.size) {
      this.motionWaitLastSeconds = 0;
      return;
    }
    const now = nowSeconds();
    const deltaSeconds = Math.max(0, now - this.motionWaitLastSeconds);
    this.motionWaitLastSeconds = now;
    const speed = Math.max(0, this.Model.getCurrentSpeedRate());
    for (const [target, queue] of [...this.motionWaitQueues]) {
      // Native AdvMotionController only advances a wait while the associated
      // A character provider reports showing state. A pending model still counts:
      // native CharacterIn is synchronous after its preload has completed.
      if (!this.SceneRoot.isCharacterShowing(target, queue.current.identity)) continue;
      queue.current.remainingSeconds -= deltaSeconds * speed;
      if (queue.current.remainingSeconds > 0) continue;
      const completed = queue.current;
      const next = queue.queued.shift();
      if (next) queue.current = next;
      else this.motionWaitQueues.delete(target);
      // Native starts the next queue entry with its full wait on a later
      // update; elapsed overshoot is intentionally not carried forward.
      completed.play();
    }
    if (this.motionWaitQueues.size) this.scheduleMotionWaitFrame();
    else this.motionWaitLastSeconds = 0;
  };

  private cancelWaitingMotionsForTarget(target: string): void {
    this.motionWaitQueues.delete(target);
    if (this.motionWaitQueues.size || this.motionWaitFrame == null) return;
    cancelAnimationFrame(this.motionWaitFrame);
    this.motionWaitFrame = null;
    this.motionWaitLastSeconds = 0;
  }

  private playLastQueuedMotions(): void {
    if (this.motionWaitFrame != null) cancelAnimationFrame(this.motionWaitFrame);
    this.motionWaitFrame = null;
    const queues = [...this.motionWaitQueues.values()];
    this.motionWaitQueues.clear();
    this.motionWaitLastSeconds = 0;
    for (const queue of queues) (queue.queued.at(-1) || queue.current).play();
  }

  private cancelMotionWaitTasks(): void {
    if (this.motionWaitFrame != null) cancelAnimationFrame(this.motionWaitFrame);
    this.motionWaitFrame = null;
    this.motionWaitQueues.clear();
    this.motionWaitLastSeconds = 0;
  }

  private refreshBackgroundDoFCommandController(signal?: AbortSignal): AbortController {
    this.backgroundDoFCommandController?.abort();
    const controller = createAbortLink(this.abortController.signal, signal);
    this.backgroundDoFCommandController = controller;
    return controller;
  }

  private releaseBackgroundDoFCommandController(controller: AbortController): void {
    if (this.backgroundDoFCommandController === controller) this.backgroundDoFCommandController = null;
  }

  private refreshCharacterDoFCommandOwner(
    positionType: number,
    target: string,
    signal?: AbortSignal,
  ): AdvCharacterDoFCommandOwner {
    const previous = this.characterDoFCommandOwners.get(positionType);
    if (previous) {
      // The DoF helper's own token is refreshed before DelaySeconds. Record
      // that cancellation even if the replacing command is later CancelDelay'd.
      this.SceneRoot.cancelPendingCharacterDoF(previous.target);
      previous.controller.abort();
    }
    const owner = {
      controller: createAbortLink(this.abortController.signal, signal),
      target,
    };
    this.characterDoFCommandOwners.set(positionType, owner);
    return owner;
  }

  private releaseCharacterDoFCommandOwner(positionType: number, owner: AdvCharacterDoFCommandOwner): void {
    if (this.characterDoFCommandOwners.get(positionType) === owner) {
      this.characterDoFCommandOwners.delete(positionType);
    }
  }

  private cancelDoFCommandOwners(): void {
    this.backgroundDoFCommandController?.abort();
    this.backgroundDoFCommandController = null;
    for (const owner of this.characterDoFCommandOwners.values()) owner.controller.abort();
    this.characterDoFCommandOwners.clear();
  }

  private cancelShakeWait(): void {
    const controller = this.shakeWaitController;
    this.shakeWaitController = null;
    controller?.abort();
  }

  private cancelClipPlaybackWatch(): void {
    const controller = this.clipPlaybackController;
    this.clipPlaybackController = null;
    controller?.abort();
  }

  private watchClipPlaybackCompletion(videoInfo: unknown): void {
    this.cancelClipPlaybackWatch();
    const controller = createAbortLink(this.abortController.signal);
    this.clipPlaybackController = controller;
    void this.SceneRoot.waitVideoEnded(controller.signal).then(() => {
      if (
        controller.signal.aborted ||
        this.disposed ||
        this.clipPlaybackController !== controller ||
        this.Session.CurrentVideoInfo !== videoInfo
      ) {
        return;
      }
      this.clipPlaybackController = null;
      this.Session.VideoPlaying = false;
      this.Session.FlowParameters.setClipVideoPlaying(false);
      this.Session.FlowParameters.setClipSkip(false);
    });
  }

  /** AdvPlayerHelper.DelayWithSpeedAdjustment over unscaled system time. */
  private delayWithSpeedAdjustment(seconds: number, signal?: AbortSignal): Promise<void> {
    let remaining = Math.max(0, finite(seconds));
    if (remaining <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let frame = 0;
      let settled = false;
      let previousSeconds = nowSeconds();
      let previousSpeed = Math.max(0.01, this.Model.getCurrentSpeedRate());
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (frame) cancelAnimationFrame(frame);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const update = (): void => {
        if (signal?.aborted) {
          finish();
          return;
        }
        const currentSeconds = nowSeconds();
        const systemDelta = Math.max(0, currentSeconds - previousSeconds);
        previousSeconds = currentSeconds;
        const currentSpeed = Math.max(0.01, this.Model.getCurrentSpeedRate());
        if (Math.abs(currentSpeed - previousSpeed) > 0.000001) {
          remaining *= previousSpeed / currentSpeed;
          previousSpeed = currentSpeed;
        }
        if (!this.Model.isPause) remaining -= systemDelta;
        if (remaining <= 0) finish();
        else frame = requestAnimationFrame(update);
      };
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
      else frame = requestAnimationFrame(update);
    });
  }

  maybeFinishActiveSeek(_commands: AdvCommand[]) {
    const seek = this.activeSeek;
    if (!seek || this.Model.CurrentEpisodeListIndex < seek.target) return false;
    this.activeSeek = null;
    try {
      this.finishSeekRestoration(seek.target, seek.paused);
      seek.resolve();
    } catch (error) {
      seek.reject(error);
      throw error;
    } finally {
      seek.controller.abort();
    }
    return true;
  }

  dispose(options: { releaseTextures?: boolean } = {}): Promise<void> {
    const releaseTextures = options.releaseTextures !== false;
    if (this.disposal) {
      if (releaseTextures && !this.disposalReleasesTextures) {
        this.disposalReleasesTextures = true;
        this.disposal = this.disposal.then(() => this.SceneRoot.destroy({ releaseTextures: true }));
      }
      return this.disposal;
    }
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.disposalReleasesTextures = releaseTextures;
    this.bootGeneration += 1;
    // Route changes and restart reuse one Vue reactive object. Detach every
    // old owner before aborting waits: abort/finally continuations must write
    // into this private clone, never into the next story's state.
    const visibleState = this.state;
    visibleState.loading = false;
    visibleState.ready = false;
    visibleState.playing = false;
    visibleState.seeking = false;
    visibleState.session = null;
    this.cancelChatTyping();
    this.beginTalkPresentation();
    this.Session.cancelVoicePlaybackScope();
    const detachedState = createDetachedAdvPlayerState(visibleState);
    this.state = detachedState;
    this.Context.state = detachedState;
    this.Loader.state = detachedState;
    this.SoundManager.state = detachedState as unknown as typeof this.SoundManager.state;
    this.SceneRoot.detachState(detachedState);
    this.cancelAutoAdvance();
    const seek = this.activeSeek;
    this.activeSeek = null;
    seek?.controller.abort();
    seek?.resolve();
    this.Model.shouldShortCut = false;
    this.Model.shortCutIndex = -1;
    this.state.seeking = false;
    this.SceneRoot.setDeterministicReplayActive(false);
    this.PlayableDirector.deactivate();
    this.commandGroupScheduler.cancelAll();
    this.abortController.abort();
    this.Loader.dispose();
    this.cancelMotionWaitTasks();
    this.cancelDoFCommandOwners();
    this.cancelShakeWait();
    this.cancelClipPlaybackWatch();
    this.choiceResolver?.(ABORTED_CHOICE);
    this.choiceResolver = null;
    this.releasePlaybackResumeWaiters();
    this.executionObserver = null;
    this.executionObservers.clear();
    this.presentationObservers.clear();
    releaseCheckpointIndexes(this);
    this.lastSharedCheckpoint = undefined;
    this.Model.dispose();
    this.SoundManager.dispose();
    this.detachedCommandTasks.clear();
    try {
      this.disposal = Promise.resolve(
        this.SceneRoot.destroy({
          releaseTextures,
        }),
      );
    } catch (error) {
      this.disposal = Promise.reject(error);
    }
    return this.disposal;
  }

  resize() {
    if (this.disposed) return;
    this.SceneRoot.resize();
  }

  indexEpisodeKeys() {
    this.keyToListIndex.clear();
    (this.story?.commands || []).forEach((cmd, index) => {
      if (cmd.key) this.keyToListIndex.set(cmd.key, index);
    });
  }

  async play() {
    if (this.idleSeekDrain) await this.idleSeekDrain;
    if (this.disposed || this.abortController.signal.aborted || this.state.playing) return;
    this.state.playing = true;
    this.state.finished = false;
    this.Model.shouldShortCut = false;
    try {
      const commands = this.story?.commands || [];
      while (
        !this.abortController.signal.aborted &&
        (this.Model.CurrentEpisodeListIndex < commands.length || this.restoredDialoguePending)
      ) {
        await this.waitWhilePlaybackPaused(this.abortController.signal);
        if (this.disposed || this.abortController.signal.aborted) return;
        if (this.activeSeek) {
          await this.settleDetachedCommandTasks();
          this.SceneRoot.setDeterministicReplayActive(true);
          await this.reconcileActiveSeekCheckpoint();
          const resume = this.activeSeek?.resume;
          if (this.maybeFinishActiveSeek(commands) && !resume) return;
          continue;
        }
        if (this.restoredDialoguePending) {
          this.restoredDialoguePending = false;
          const seconds =
            Math.max(
              finite(this.runtime.minTalkDisplayTime, 1.6),
              this.state.talk.text.length * finite(this.runtime.waitTalkTextUnitTime, 0.04),
            ) + this.autoPlayIntervalSeconds;
          this.autoAdvanceAfter(seconds);
          await this.Model.waitForNext(this.abortController.signal);
          continue;
        }
        const index = this.Model.CurrentEpisodeListIndex;
        const command = commands[index];
        if (command) {
          await this.notifyExecutionBoundary({
            phase: "before",
            commandIndex: index,
            command,
          });
          await this.waitWhilePlaybackPaused(this.abortController.signal);
          if (this.disposed || this.abortController.signal.aborted) return;
        }
        if (!this.playbackCommandController || this.playbackCommandController.signal.aborted) {
          this.playbackCommandController = createAbortLink(this.abortController.signal);
        }
        const execution = this.executeCommandAtIndex(commands, index, this.playbackCommandController.signal);
        const executedCommand = this.state.currentCommand || command;
        if (command) {
          await this.notifyExecutionBoundary({
            phase: "started",
            commandIndex: index,
            command: executedCommand,
          });
        }
        if (execution) await execution;
        if (command) {
          await this.notifyExecutionBoundary({
            phase: "after",
            commandIndex: index,
            command: executedCommand,
          });
        }
        if (this.activeSeek) {
          await this.settleDetachedCommandTasks();
          this.SceneRoot.setDeterministicReplayActive(true);
          await this.reconcileActiveSeekCheckpoint();
        }
        this.maybeCaptureCheckpoint(commands[index], this.Model.CurrentEpisodeListIndex);
        if (!this.activeSeek && Number(command?.command) === ADV_COMMAND.ChoiceShow) {
          const decisions = new Map(this.Session.choiceRecords);
          const pathIndex = this.seekIndexFor(decisions);
          if (!pathIndex.complete && pathIndex.blockedAt == null) {
            await this.settleDetachedCommandTasks();
            await this.SceneRoot.settleSeekSnapshotResources();
            if (!pathIndex.checkpoints.has(this.Model.CurrentEpisodeListIndex)) {
              this.captureCheckpoint(this.Model.CurrentEpisodeListIndex);
            }
            await this.ensureSeekIndex(decisions);
          }
        }
        const resume = (this.activeSeek as AdvSeekRequest | null)?.resume;
        if (this.maybeFinishActiveSeek(commands)) {
          if (!resume) return;
          continue;
        }
      }
      if (this.disposed || this.abortController.signal.aborted) return;
      await this.commandGroupScheduler.waitForIdle(this.abortController.signal);
      if (this.disposed || this.abortController.signal.aborted) return;
      await this.SceneRoot.clearCommandPostEffects(0);
      if (!this.disposed && !this.abortController.signal.aborted) {
        this.state.finished = true;
        this.retainFinishedRenderState();
      }
    } finally {
      if (!this.disposed) this.state.playing = false;
    }
  }

  private retainFinishedRenderState(): void {
    this.cancelAutoAdvance();
    this.beginTalkPresentation();
    this.Session.cancelVoicePlaybackScope();
    this.cancelMotionWaitTasks();
    this.commandGroupScheduler.cancelAll();
    this.PlayableDirector.deactivate();
    this.SoundManager.stopTransientForSeek();
    this.SceneRoot.stopAllTimedPseudoLipSync();
    this.SceneRoot.stopAllSpeaking();
  }

  pause() {
    if (this.activeSeek) this.activeSeek.paused = true;
    this.Model.isPause = true;
    this.state.paused = true;
  }

  resume() {
    if (this.activeSeek) this.activeSeek.paused = false;
    this.Model.isPause = false;
    this.state.paused = false;
    this.releasePlaybackResumeWaiters();
  }

  private async notifyExecutionBoundary(boundary: AdvPlayerExecutionBoundary): Promise<void> {
    const observers = [...(this.executionObserver ? [this.executionObserver] : []), ...this.executionObservers];
    const results = await Promise.allSettled(
      observers.map((observer) => {
        try {
          return Promise.resolve(observer(boundary));
        } catch (error) {
          return Promise.reject(error);
        }
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[Vega] execution observer failed", result.reason);
      }
    }
  }

  private waitWhilePlaybackPaused(signal: AbortSignal): Promise<void> {
    if (!this.Model.isPause || signal.aborted || this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = (): void => {
        this.playbackResumeWaiters.delete(finish);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      this.playbackResumeWaiters.add(finish);
      signal.addEventListener("abort", finish, { once: true });
      if (!this.Model.isPause || signal.aborted || this.disposed) finish();
    });
  }

  private releasePlaybackResumeWaiters(): void {
    for (const resolve of [...this.playbackResumeWaiters]) resolve();
  }

  requestNext() {
    this.cancelAutoAdvance();
    // UIAdvWidget.NextButton is locked for the complete native choice flow.
    if (this.choiceResolver) return;
    if (!this.Model.currentTypingController) this.manualAdvanceGeneration += 1;
    this.commandGroupScheduler.requestManualAdvance();
    this.Model.requestNext();
  }

  toggleAuto() {
    this.Model.isAutoPlay = !this.Model.isAutoPlay;
    this.state.autoPlay = this.Model.isAutoPlay;
    if (!this.Model.isAutoPlay) this.cancelAutoAdvance();
    if (this.Model.isAutoPlay && this.Model.NextStepState === 1) this.Model.changeGoNextState();
  }

  toggleFast() {
    this.Model.playbackSpeed = this.Model.playbackSpeed === 20 ? 10 : 20;
    this.state.fastForward = this.Model.playbackSpeed === 20;
    this.SceneRoot.setPlaybackSpeed(this.Model.getCurrentSpeedRate());
    // AdvPlayerUIEventHandler reapplies the new playback speed first, then
    // stops the current voices and every showing controller's lip sync. A
    // timed-pseudo mouth must not survive the fast-forward boundary.
    this.SoundManager.stopVoices();
    this.SceneRoot.stopAllSpeaking();
  }

  setTextSpeed(rate: number): void {
    const value = Number(rate);
    this.textSpeedRate = Number.isFinite(value) ? Math.max(0.1, Math.min(5, value)) : 1;
  }

  skip() {
    this.cancelAutoAdvance();
    this.commandGroupScheduler.cancelAll();
    this.beginTalkPresentation();
    this.Session.cancelVoicePlaybackScope();
    if (this.skipCurrentVideo()) return;
    this.Model.shouldShortCut = true;
    this.Model.CurrentEpisodeListIndex = this.story?.commands?.length || 0;
    this.Model.changeGoNextState();
    this.state.playing = false;
  }

  skipCurrentVideo(): boolean {
    if (this.disposed || !this.SceneRoot.skipVideo()) return false;
    this.cancelAutoAdvance();
    this.Session.FlowParameters.setClipSkip(true);
    this.Session.FlowParameters.setClipVideoPlaying(false);
    this.Session.VideoPlaying = false;
    void this.SceneRoot.hideVideo(0).catch(() => {});
    this.Model.changeGoNextState();
    return true;
  }

  seekVideoRatio(ratio: unknown) {
    return this.SceneRoot.seekVideoRatio(ratio);
  }

  choose(key: unknown) {
    const activeChoice = this.state.choices.items.find((choice) => choice.key === key);
    if (activeChoice?.enabled === false) return;
    if (this.choiceResolver) {
      const resolve = this.choiceResolver;
      this.choiceResolver = null;
      resolve(key);
    }
  }

  setLocale(locale: string, options: { refresh?: boolean } = {}): void {
    const next = locale || "auto";
    if (next === this.locale && !options.refresh) return;
    this.locale = next;
    this.talkTypingController?.finish();
    this.chatTypingController?.finish();
    this.refreshLocalizedPresentation();
  }

  holdRestoredDialogue(): void {
    this.restoredDialoguePending = this.state.talk.visible && !this.state.chat.visible && !this.state.choices.visible;
  }

  resolveDialogue(command: AdvCommand): { speaker: StoryResolvedText; text: StoryResolvedText } {
    return {
      speaker: targetDisplayName(command, this.runtime, this.resolveLocalizedText),
      text: command.textSegments
        ? joinLocalizedText(command.textSegments.map(this.resolveLocalizedText), "")
        : this.resolveLocalizedText(command.text ?? ""),
    };
  }

  dialogueSources(command: AdvCommand): { text: unknown; texts: unknown[]; speakers: unknown[]; separator: string } {
    const names = arrayValue(commandTargetTextNames(command)).filter((value) =>
      this.resolveLocalizedText(value).text.trim(),
    );
    const targets = (command.targets ?? [])
      .map((target) => target.name || target.target)
      .filter((value) => this.resolveLocalizedText(value).text);
    return {
      text: command.text ?? "",
      texts: command.textSegments ?? [command.text ?? ""],
      speakers:
        command.targetStatus === 2
          ? []
          : command.targetStatus === 1
            ? ["???"]
            : names.length
              ? names
              : targets.length
                ? targets
                : [command.targetName ?? ""],
      separator: this.runtime.targetNameSplitKey || "・",
    };
  }

  private refreshLocalizedPresentation(): void {
    const talk = this.state.talk;
    if (talk.sourceCommand) {
      const { speaker, text } = this.resolveDialogue(talk.sourceCommand);
      Object.assign(talk, {
        speaker: speaker.text,
        speakerLang: speaker.lang,
        text: text.text,
        textLang: text.lang,
        displayedText: text.text,
        textComplete: true,
        instantReveal: true,
        prefixLength: talk.sourceCommand.textSegments
          ? joinLocalizedText(talk.sourceCommand.textSegments.slice(0, -1).map(this.resolveLocalizedText), "").text
              .length
          : 0,
      });
    }
    for (const item of [this.state.location, this.state.title]) {
      if (item.sourceText === undefined) continue;
      const value = this.resolveLocalizedText(item.sourceText);
      item.text = value.text;
      item.lang = value.lang;
    }
    const subtitles = this.state.subtitles;
    if (subtitles.sourceText !== undefined) {
      const value = this.resolveLocalizedText(subtitles.sourceText);
      updateSubtitlesState(subtitles, value.text, value.lang, subtitles.visible);
    }
    for (const item of this.state.choices.items) {
      if (item.sourceText === undefined) continue;
      const value = this.resolveLocalizedText(item.sourceText);
      item.text = value.text;
      item.lang = value.lang;
    }
    const chat = this.state.chat;
    if (chat.sourceCommand) {
      const value = chatWindowDisplayName(chat.sourceCommand, this.runtime, this.resolveLocalizedText);
      chat.title = value.text;
      chat.titleLang = value.lang;
    }
    if (chat.typing && chat.typingSource !== undefined) {
      const value = this.resolveLocalizedText(chat.typingSource);
      chat.typing = value.text;
      chat.typingLang = value.lang;
    }
    const translate = <T extends { sourceCommand?: AdvCommand; stamp?: unknown }>(item: T): T => {
      if (!item.sourceCommand) return item;
      const { speaker, text } = this.resolveDialogue(item.sourceCommand);
      return {
        ...item,
        speaker: speaker.text,
        speakerLang: speaker.lang,
        ...(item.stamp ? {} : { text: text.text, textLang: text.lang }),
      };
    };
    chat.messages = chat.messages.map(translate);
    this.state.talkLog = this.Session.TalkLog.map(translate);
    for (const observer of [...this.presentationObservers]) {
      try {
        observer();
      } catch (error) {
        console.error("[Vega] presentation observer failed", error);
      }
    }
  }

  navigateToKey(key: string): boolean {
    return this.goToEpisodeKey(key);
  }

  finish(): void {
    this.commandGroupScheduler.cancelAll();
    this.state.finished = true;
    this.Model.CurrentEpisodeListIndex = this.story?.commands?.length || 0;
    this.Model.changeGoNextState();
  }

  private goToEpisodeKey(episodeKey: unknown): boolean {
    const key = typeof episodeKey === "string" ? episodeKey : "";
    const index = this.keyToListIndex.get(key);
    if (index == null) return false;
    this.commandGroupScheduler.cancelAll();
    this.Model.CurrentEpisodeListIndex = index;
    return true;
  }

  autoAdvanceAfter(seconds: number) {
    this.cancelAutoAdvance();
    if (!this.Model.isAutoEnabled) return;
    const controller = createAbortLink(this.abortController.signal);
    this.autoAdvanceController = controller;
    this.delayWithSpeedAdjustment(seconds, controller.signal)
      .then(() => {
        if (this.autoAdvanceController === controller) this.autoAdvanceController = null;
        if (!controller.signal.aborted && this.Model.isAutoEnabled) this.Model.changeGoNextState();
        // Detach the linked parent abort listener after normal completion.
        controller.abort();
      })
      .catch(() => {
        if (this.autoAdvanceController === controller) this.autoAdvanceController = null;
        controller.abort();
      });
  }

  setAutoPlayInterval(value: unknown) {
    this.autoPlayIntervalIndex = normalizeAutoPlayInterval(value);
    this.autoPlayIntervalSeconds = autoPlayIntervalSeconds(value);
  }

  setAutoPlayDelaySeconds(value: number): void {
    this.autoPlayIntervalSeconds = Math.max(0, Math.min(30, finite(value, 1.5)));
    this.autoPlayIntervalIndex = Math.round(this.autoPlayIntervalSeconds * 2);
  }

  setSubtitlesEnabled(enabled: boolean): void {
    const subtitlesEnabled = Boolean(enabled);
    this.Model.setSubtitlesEnabled(subtitlesEnabled);
    const subtitles = this.state.subtitles;
    if (!subtitlesEnabled) {
      subtitles.visible = false;
      return;
    }
    subtitles.text = subtitles.lastText;
    subtitles.lang = subtitles.lastLang;
    subtitles.visible = Boolean(subtitles.lastText);
  }

  cancelAutoAdvance() {
    if (!this.autoAdvanceController) return;
    this.autoAdvanceController.abort();
    this.autoAdvanceController = null;
  }

  async waitForRead(textLength = 0, minimumAutoSeconds = 0, signal: AbortSignal = this.abortController.signal) {
    if (this.disposed || signal.aborted || this.Model.shouldShortCut) return;
    const unit = finite(this.runtime.waitTalkTextUnitTime, 0.04) / this.Model.getCurrentSpeedRate();
    const min = finite(this.runtime.minTalkDisplayTime, 1.6) / this.Model.getCurrentSpeedRate();
    const seconds = advAutoPlayReadDelaySeconds(
      min,
      textLength * unit,
      finite(minimumAutoSeconds, 0),
      this.autoPlayIntervalSeconds,
    );
    this.autoAdvanceAfter(seconds);
    await this.Model.waitForNext(signal);
  }

  async waitForChatRead(textLength = 0, minimumAutoSeconds = 0, signal: AbortSignal = this.abortController.signal) {
    if (this.disposed || signal.aborted || this.Model.shouldShortCut) return;
    if (this.Model.isAutoEnabled) {
      const unit = finite(this.runtime.waitTalkTextUnitTime, 0.04) / this.Model.getCurrentSpeedRate();
      const min = finite(this.runtime.minTalkDisplayTime, 1.6) / this.Model.getCurrentSpeedRate();
      this.autoAdvanceAfter(Math.max(min, textLength * unit, finite(minimumAutoSeconds, 0)));
    }
    await this.Model.waitForNext(signal);
  }

  private cancelChatTyping(clearText = true): void {
    this.chatTypingGeneration += 1;
    const controller = this.chatTypingController;
    this.chatTypingController = null;
    if (this.Model.currentTypingController === controller) this.Model.currentTypingController = null;
    if (clearText) {
      this.state.chat.typing = "";
      this.state.chat.typingLang = undefined;
    }
  }

  private beginTalkPresentation(): number {
    const controller = this.talkTypingController;
    this.talkTypingController = null;
    if (this.Model.currentTypingController === controller) this.Model.currentTypingController = null;
    this.talkPresentationGeneration += 1;
    return this.talkPresentationGeneration;
  }

  private async typeChatTypingText(
    text: string,
    lang: string | undefined,
    memoryId: string,
    ctx: AdvCommandContext,
    signal: AbortSignal,
  ): Promise<number> {
    this.cancelChatTyping();
    ctx.state.chat.typingLang = lang;
    const generation = ++this.chatTypingGeneration;
    const characters = Array.from(String(text || ""));
    if (!characters.length || ctx.Model.shouldShortCut || signal.aborted) {
      if (visibleChatMemory(ctx, memoryId)) ctx.state.chat.typing = text;
      return characters.length;
    }

    let finished = false;
    const controller = {
      finish: () => {
        if (generation !== this.chatTypingGeneration || !visibleChatMemory(ctx, memoryId)) return;
        finished = true;
        ctx.state.chat.typing = text;
      },
    };
    this.chatTypingController = controller;
    this.Model.currentTypingController = controller;
    const characterDelay =
      ADV_CHAT_TYPING_DELAY_SECONDS / Math.max(ctx.Model.getCurrentSpeedRate(), ADV_CHAT_MIN_PLAYBACK_SPEED);
    let displayed = "";
    try {
      for (const character of characters) {
        if (finished) break;
        await delaySeconds(characterDelay, signal);
        if (signal.aborted || generation !== this.chatTypingGeneration || !visibleChatMemory(ctx, memoryId)) {
          return characters.length;
        }
        if (finished) break;
        displayed += character;
        ctx.state.chat.typing = displayed;
      }
      if (!finished && generation === this.chatTypingGeneration && visibleChatMemory(ctx, memoryId))
        ctx.state.chat.typing = text;
      return characters.length;
    } finally {
      if (this.chatTypingController === controller) this.chatTypingController = null;
      if (this.Model.currentTypingController === controller) this.Model.currentTypingController = null;
    }
  }

  private autoAdvanceWhenReadable(
    textLength: number,
    voicePlayIds: readonly number[],
    voicePlaybackScopeVersion: number,
    signal: AbortSignal,
    intervalSeconds: number,
  ): void {
    this.cancelAutoAdvance();
    if (!this.Model.isAutoEnabled || this.disposed || signal.aborted) return;
    const scopeSignal = this.Session.voicePlaybackScopeSignal(voicePlaybackScopeVersion);
    if (!scopeSignal) return;

    const controller = createAbortLink(this.abortController.signal, signal, scopeSignal);
    this.autoAdvanceController = controller;
    const speed = Math.max(0.01, this.Model.getCurrentSpeedRate());
    const readSeconds = Math.max(
      finite(this.runtime.minTalkDisplayTime, 1.6) / speed,
      Math.max(0, textLength) * (finite(this.runtime.waitTalkTextUnitTime, 0.04) / speed),
    );
    const ownsScope = () => this.Session.isVoicePlaybackScopeCurrent(voicePlaybackScopeVersion);

    const waitForVoice = async (): Promise<boolean> => {
      if (!voicePlayIds.length) return true;
      const completedNaturally = await this.SoundManager.waitForVoicePlayback(voicePlayIds, {
        signal: controller.signal,
        scopeSignal,
        isScopeCurrent: ownsScope,
      });
      if (controller.signal.aborted || !ownsScope()) return false;
      if (completedNaturally) {
        await delaySeconds(finite(this.runtime.waitAfterVoiceTime, 0), controller.signal);
      }
      return !controller.signal.aborted && ownsScope();
    };

    const advance = async (): Promise<void> => {
      const [, voiceReady] = await Promise.all([delaySeconds(readSeconds, controller.signal), waitForVoice()]);
      if (!voiceReady || controller.signal.aborted || !this.Model.isAutoEnabled || !ownsScope()) return;
      await delaySeconds(Math.max(0, finite(intervalSeconds, 0)), controller.signal);
      if (!controller.signal.aborted && this.Model.isAutoEnabled && ownsScope()) this.Model.changeGoNextState();
    };

    void advance().finally(() => {
      if (this.autoAdvanceController === controller) this.autoAdvanceController = null;
      controller.abort();
    });
  }

  private async waitForReadableAdvance(
    textLength: number,
    voicePlayIds: readonly number[],
    voicePlaybackScopeVersion: number,
    signal: AbortSignal,
    intervalSeconds: number,
  ): Promise<void> {
    if (this.disposed || signal.aborted || this.Model.shouldShortCut) return;
    this.autoAdvanceWhenReadable(textLength, voicePlayIds, voicePlaybackScopeVersion, signal, intervalSeconds);
    await this.Model.waitForNext(signal);
  }

  async typeTalkText(
    text: string,
    presentationGeneration: number,
    signal: AbortSignal,
    isCurrent: () => boolean,
    presentation?: AdvCommand["talkPresentation"],
    prefix = "",
  ) {
    const full = String(text || "");
    const talk = this.state.talk as Record<string, unknown>;
    const ownsPresentation = () =>
      presentationGeneration === this.talkPresentationGeneration && !this.disposed && !signal.aborted && isCurrent();
    if (!ownsPresentation()) return;
    talk.displayedText = prefix;
    talk.textComplete = false;
    talk.instantReveal = false;
    if (this.state.instantText || this.Model.shouldShortCut) {
      talk.instantReveal = true;
      talk.displayedText = full;
      talk.textComplete = true;
      return;
    }
    let finished = false;
    const typingController = {
      finish: () => {
        if (!ownsPresentation()) return;
        finished = true;
        talk.instantReveal = true;
        talk.displayedText = full;
        talk.textComplete = true;
      },
    };
    this.talkTypingController = typingController;
    this.Model.currentTypingController = typingController;
    const authoredRate = Number(presentation?.textReveal?.unitsPerSecond);
    const characterDelay =
      (Number.isFinite(authoredRate) && authoredRate > 0 ? 1 / authoredRate : 0.05) /
      Math.max(0.01, this.Model.getCurrentSpeedRate() * this.textSpeedRate);
    const suffix = full.slice(prefix.length);
    const characters = presentation?.textReveal?.unit === "utf16-code-unit" ? suffix.split("") : Array.from(suffix);
    let displayed = prefix;
    try {
      for (const character of characters) {
        if (finished || !ownsPresentation()) return;
        if (presentation?.textReveal?.delayFirstUnit) await delaySeconds(characterDelay, signal);
        if (finished || !ownsPresentation()) return;
        displayed += character;
        if (ownsPresentation()) talk.displayedText = displayed;
        if (!presentation?.textReveal?.delayFirstUnit) await delaySeconds(characterDelay, signal);
      }
      if (!finished && ownsPresentation()) {
        talk.displayedText = full;
        talk.textComplete = true;
      }
    } finally {
      if (this.talkTypingController === typingController) this.talkTypingController = null;
      if (this.Model.currentTypingController === typingController) this.Model.currentTypingController = null;
    }
  }

  registerCommands() {
    const localizedText = this.resolveLocalizedText;
    const register = (command: number, execute: AdvCommandHandler) => {
      if (!isVegaNativeOpcode(command) && command !== ADV_COMMAND.CommandGroup)
        throw new RangeError(`Unrecognized native ADV opcode: ${command}`);
      this.CommandService.registerCommand(command, { execute });
    };

    register(ADV_COMMAND.CommandGroup, async (cmd, ctx, signal) => {
      const commandSignal = signal || this.abortController.signal;
      if (ctx.Model.shouldShortCut) {
        await this.commandGroupScheduler.admitImmediate(cmd.commandGroup, commandSignal);
        return;
      }
      await this.commandGroupScheduler.admit(cmd.commandGroup, commandSignal);
    });

    const syncPanV2BaseFromFocus = (
      ctx: AdvCommandContext,
      positionType: number,
      targetName: string,
      cameraDistance: number,
    ) => {
      const resolvedPositionType = Number(positionType) || ctx.SceneRoot.cameraState.focusPositionType || 5;
      const focusData = ctx.SceneRoot.currentFocusData(cameraDistance);
      const basePosition = ctx.SceneRoot.focusBaseCameraPosition(resolvedPositionType, targetName, focusData);
      ctx.Session.setCurrentFocusCameraPosition({
        x: basePosition.x,
        y: basePosition.y,
        z: 0,
      });
      ctx.Session.setCurrentFocusCameraZoomRatio(focusData?.fieldZoomRatio ?? ctx.Session.CurrentFocusCameraZoomRatio);
      ctx.Session.setCurrentPanV2BaseCameraPosition(basePosition);
      ctx.Session.setCurrentPanV2CameraOffset({ x: 0, y: 0 });
      return basePosition;
    };
    const playCharacterPresentation = (cmd: AdvCommand, ctx: AdvCommandContext, target: string): void => {
      const presentation = cmd.characterPresentation;
      if (!presentation) return;
      const identity = ctx.SceneRoot.characterMotionIdentity(target);
      if (!identity) return;
      // A negative value preserves the animation asset's authored fade. This
      // is required by imported C2 motions that carry their own per-motion and
      // per-parameter transition times.
      const fadeIn = ctx.Model.shouldShortCut ? 0 : finite(presentation.fadeInSeconds, -1);
      const motionName = String(presentation.motionName || "").trim();
      const expressionName = String(presentation.expressionName || "").trim();
      if (motionName) ctx.SceneRoot.playMotionForTarget(target, motionName, fadeIn, identity);
      if (expressionName) ctx.SceneRoot.playExpressionForTarget(target, expressionName, fadeIn, identity);
    };

    register(ADV_COMMAND.Character, async (cmd, ctx) => {
      ctx.Loader.registerCharacterAsset(cmd);
    });

    register(ADV_COMMAND.Costume, async (cmd, ctx) => {
      for (const target of targetKeys(cmd)) {
        const assetIndex = (cmd.targetAssetIndex as number) || 0;
        ctx.Loader.setCharacterAssetIndex(target, assetIndex);
        ctx.SceneRoot.selectCharacterAssetIndex(target, assetIndex);
      }
    });

    register(ADV_COMMAND.Stage, async (cmd, ctx, signal) => {
      const duration = commandDuration(ctx, cmd, 0);
      const applyStageState = (): void => {
        ctx.Session.setCurrentStage(cmd.background?.stage || null);
        ctx.Session.setCurrentFocusCameraPosition(ctx.SceneRoot.focusPoint(5) as { x: number; y: number; z: number });
        ctx.Session.setCurrentFocusCameraZoomRatio(1);
        ctx.Session.setCurrentPanV2BaseCameraPosition({ x: 0, y: 0, z: 0 });
        ctx.Session.setCurrentPanV2CameraOffset({ x: 0, y: 0 });
        ctx.SceneRoot.setPanV2CameraOffset({ x: 0, y: 0 }, 0, 0);
      };
      await this.runCommandTask(cmd, async () => {
        if (duration <= 0) {
          // AdvStageCommand skips ScreenCapture/ResetCaptureTexture entirely
          // when CalcDuration returns zero.
          if (await ctx.SceneRoot.setBackground(cmd.background, 0, undefined, signal)) applyStageState();
          return;
        }
        const captureToken = await ctx.SceneRoot.captureStage(signal);
        if (captureToken == null) return;
        const swapped = await ctx.SceneRoot.setBackground(cmd.background, 0, captureToken, signal);
        if (!swapped) return;
        applyStageState();
        await ctx.SceneRoot.fadeStageCapture(duration, captureToken, signal);
      });
    });

    register(ADV_COMMAND.Frame, async (cmd, ctx, signal) => {
      const stateName = param(cmd, 1);
      const explicitHide = /hide/i.test(stateName);
      const frameName = frameCommandKey(cmd, cmd.frame || null);
      const frameStates = ensureFrameStateMap(ctx.state);
      const currentFrameState = frameStates[frameName] || null;
      const sameVisibleFrame =
        !String(stateName || "").trim() &&
        frameName &&
        currentFrameState &&
        finite(currentFrameState.opacity, 0) > 0.001;
      const hide = explicitHide || sameVisibleFrame;
      const frame = hide
        ? currentFrameState?.frame || cmd.frame || null
        : cmd.frame || currentFrameState?.frame || null;
      if (!frame || !frameName) return;
      const customState = Boolean(String(stateName || "").trim());
      const delay = ctx.Model.calcDuration(finite(cmd.delaySeconds, 0), 0);
      const explicitFadeDuration = optionalFinite(param(cmd, 0), 0);
      const fadeDuration = ctx.Model.calcDuration(
        explicitFadeDuration > 0 ? explicitFadeDuration : finite(cmd.duration, 0),
        0,
      );
      const animationDuration = frameClipDuration(ctx, stateName, frame);
      const task = async () => {
        const commandSignal = signal || this.abortController.signal;
        if (!hide) {
          await ctx.SceneRoot.setFrameOverlay(frame, 0, frameName);
          ctx.state.frame = frame;
          ctx.state.frameName = frameName;
          frameStates[frameName] = { frame, opacity: 0, slide: 1 };
        }
        const completed = await ctx.Session.DelayTokens.delay(delay, commandSignal);
        if (!completed || this.disposed || commandSignal.aborted) return;
        const latestFrameState = frameStates[frameName] || currentFrameState || {};
        const from = finite(latestFrameState.opacity, hide ? frameCanvasAlpha(frame) : 0);
        const targetAlpha = hide ? 0 : frameCanvasAlpha(frame);
        if (customState && frame.type === "letterbox") {
          await tween({
            duration: animationDuration,
            signal: commandSignal,
            update: (_progress, raw) => {
              const sample = sampleAdvLetterboxAnimator(stateName, raw, frameCanvasAlpha(frame));
              ctx.state.frameOpacity = sample.opacity;
              ctx.state.frameSlide = sample.slide;
              frameStates[frameName] = {
                ...(frameStates[frameName] || {}),
                frame,
                opacity: sample.opacity,
                slide: sample.slide,
              };
              ctx.SceneRoot.setFrameOpacity(sample.opacity, sample.slide, frameName);
            },
          });
        } else {
          // ShowFrame/HideFrame use CanvasGroup.DOFade with DOTween's default
          // OutQuad ease. They do not play the custom Animator state or slide
          // the letterbox bands when Parameter2 is empty.
          await tween({
            duration: customState ? animationDuration : fadeDuration,
            ease: resolveEase(6),
            signal: commandSignal,
            update: (progress) => {
              ctx.state.frameOpacity = lerp(from, targetAlpha, progress);
              ctx.state.frameSlide = 0;
              frameStates[frameName] = {
                ...(frameStates[frameName] || {}),
                frame,
                opacity: ctx.state.frameOpacity as number,
                slide: 0,
              };
              ctx.SceneRoot.setFrameOpacity(ctx.state.frameOpacity, 0, frameName);
            },
          });
        }
        if (this.disposed || signal?.aborted || this.abortController.signal.aborted) return;
        if (hide) {
          ctx.SceneRoot.clearFrameOverlay(frameName);
          delete frameStates[frameName];
          const keys = activeFrameKeys(ctx.state);
          const lastKey = keys[keys.length - 1] || "";
          ctx.state.frame = lastKey ? frameStates[lastKey]?.frame || null : null;
          ctx.state.frameName = lastKey;
          ctx.state.frameSlide = 1;
        }
      };
      await this.runCommandTask(cmd, task);
    });

    register(ADV_COMMAND.In, async (cmd, ctx) => {
      const duration = unityCharacterFadeDuration("in", commandDuration(ctx, cmd, 0), ctx.Model.shouldShortCut);
      const clearStill = ctx.SceneRoot.clearStill(duration);
      if (cmd.noWait) this.observeDetachedCommandTask(clearStill);
      const tasks = targetKeys(cmd).map(async (target: string) => {
        let liveCmd = cmd;
        let variant: {
          characterModel: AdvCharacterModelEntry;
          characterKey?: string;
          targetAssetIndex: number;
        } | null = null;
        if (!hasAdvCharacterModel(cmd.characterModel)) {
          variant = ctx.Loader.resolveCharacterForIn(target, cmd.targetAssetIndex as number | undefined);
          if (variant) {
            liveCmd = {
              ...cmd,
              characterModel: variant.characterModel,
              characterKey: variant.characterKey,
              targetAssetIndex: variant.targetAssetIndex,
            };
          }
        } else {
          variant = {
            characterModel: cmd.characterModel!,
            characterKey: cmd.characterKey,
            targetAssetIndex: Number(cmd.targetAssetIndex) || 0,
          };
        }
        ctx.Session.placeCharacter(target, (cmd.positionType as number) || 5);
        const placement = ctx.SceneRoot.placeCharacter(
          { ...liveCmd, targetName: target, targets: [{ target }] },
          (cmd.positionType as number) || 5,
          duration,
          cmd.noWait,
        );
        // placeCharacter synchronously selects the controller identity before
        // its first resource await. Queue the authored layout presentation now
        // so a newly loaded model has it on its first visible frame.
        playCharacterPresentation(cmd, ctx, target);
        await placement;
        if (variant) ctx.Loader.setCharacterAssetIndex(target, variant.targetAssetIndex);
      });
      if (cmd.noWait) {
        // AdvInCommand.Execute dispatches AddSpeaker(...).Forget() for an
        // IsNoWait command. Let the following Motion/Expression command reach
        // the character while its browser-side model load is still pending;
        // ThreeStoryScene retains that state and evaluates it before the first
        // visible frame.
        this.observeDetachedCommandTask(Promise.all(tasks).then(() => undefined));
        return;
      }
      await Promise.all([clearStill, ...tasks]);
    });

    register(ADV_COMMAND.Out, async (cmd, ctx) => {
      const duration = unityCharacterFadeDuration("out", commandDuration(ctx, cmd, 0), ctx.Model.shouldShortCut);
      // AdvOutCommand.RemoveSpeaker hides and unregisters the renderer entry,
      // but it does not call AdvPlaybackSession.ResetCharacterPositionInfo.
      // Keep PositionType -> controller mapped while hidden: a later
      // LookTarget resolves that cached controller and samples its head anchor.
      const destination = cmd.characterWorldTransition?.to ?? cmd.characterWorldPosition;
      const restore = cmd.characterWorldTransition?.restore;
      const tasks = targetKeys(cmd).map(async (target: string) => {
        const positionType = ctx.Session.tryGetTargetNameToPositionType(target) || 5;
        playCharacterPresentation(cmd, ctx, target);
        const move = destination
          ? ctx.SceneRoot.moveCharacterToWorld(target, destination, positionType, duration, 6)
          : Promise.resolve();
        // Target motion and visibility share the authored transition duration.
        await Promise.all([move, ctx.SceneRoot.removeCharacter(target, duration)]);
        if (restore) await ctx.SceneRoot.moveCharacterToWorld(target, restore, positionType, 0, 6);
      });
      await this.runCommandTask(cmd, () => Promise.all(tasks));
    });

    register(ADV_COMMAND.Motion, (cmd, ctx) => {
      // AdvEpisode.MotionFadeIn defaults to 0. Static sparse projections made
      // that zero indistinguishable from an omitted field; only an explicit -1
      // means “use the clip setting”. Treating omission as -1 creates a bogus
      // one-second default-pose -> authored-pose turn on first appearance.
      const fadeIn = ctx.Model.shouldShortCut ? 0 : finite(cmd.motionFadeIn, 0);
      const wait = ctx.Model.shouldShortCut ? 0 : Math.max(0, finite(cmd.motionWait, 0));
      for (const target of targetKeys(cmd)) {
        const identity = ctx.SceneRoot.characterMotionIdentity(target);
        // TryGetCharacterController fails in the native command when no
        // controller has been selected for this target.
        if (!identity) continue;
        const play = () => {
          // AdvMotionData captures the controller instance at enqueue time.
          // Address the captured TargetName+Asset controller even while it is
          // hidden or a newer asset has become the target's current mapping.
          // AdvMotionCommand.Execute issues both controller calls synchronously
          // and returns a completed UniTask. Motion playback never becomes a
          // barrier in front of the following Expression/Talk command.
          ctx.SceneRoot.playMotionForTarget(target, cmd.motionName as string, fadeIn, identity);
          ctx.SceneRoot.playExpressionForTarget(target, cmd.expressionName as string, fadeIn, identity);
        };
        if (wait > 0) this.enqueueWaitingMotion(target, identity, wait, play);
        else {
          // PlayMotionInternal runs first; a zero-wait request then clears the
          // current wait and the full serial tail for this character.
          play();
          this.cancelWaitingMotionsForTarget(target);
        }
      }
    });

    register(ADV_COMMAND.Expression, (cmd, ctx) => {
      const fadeIn = ctx.Model.shouldShortCut ? 0 : finite(cmd.motionFadeIn, 0);
      for (const target of targetKeys(cmd)) {
        ctx.SceneRoot.playExpressionForTarget(target, cmd.expressionName as string, fadeIn);
      }
    });

    register(ADV_COMMAND.Pause, async (cmd, ctx) => {
      for (const target of targetKeys(cmd)) ctx.SceneRoot.setCharacterPaused(target, true);
    });

    register(ADV_COMMAND.Resume, async (cmd, ctx) => {
      for (const target of targetKeys(cmd)) ctx.SceneRoot.setCharacterPaused(target, false);
    });

    register(ADV_COMMAND.Talk, (cmd, ctx, signal) => {
      return this.runCommandTask(cmd, async () => {
        const commandSignal = signal || this.abortController.signal;
        const overlapVoices = cmd.talkPresentation?.voicePlayback === "overlap";
        const presentationGeneration = this.beginTalkPresentation();
        const source = presentationSource(cmd),
          previous = ctx.state.talk.sourceCommand;
        if (cmd.talkPresentation?.retainSpeaker && previous) {
          for (const key of [
            "targetName",
            "targetStatus",
            "targetTextNames",
            "targetTextNamesLocalized",
            "targets",
          ] as const) {
            if (previous[key] === undefined) delete source[key];
            else (source as Record<string, unknown>)[key] = clonePlain(previous[key]);
          }
        }
        const prefix = cmd.talkPresentation?.appendText && previous ? this.resolveDialogue(previous).text.text : "";
        if (cmd.talkPresentation?.appendText && previous)
          source.textSegments = [
            ...clonePlain(previous.textSegments ?? [previous.text ?? ""]),
            clonePlain(cmd.text ?? ""),
          ];
        const { speaker, text } = this.resolveDialogue(source);
        const voices = cmd.voices || [];
        const configuredLipTargets = Array.isArray(cmd.lipSyncTargets)
          ? cmd.lipSyncTargets.map((target) => String(target || ""))
          : [];
        const authoredLipTargets = configuredLipTargets.some(Boolean) ? configuredLipTargets : targetKeys(cmd);
        const lipSyncMode = String(param(cmd, 0)).trim().toLowerCase();
        const everyoneLipSyncMode = lipSyncMode === "everyonelipsync";
        const voicePlaybackScopeVersion = ctx.Session.beginVoicePlaybackScope();
        const ownsPresentation = () =>
          presentationGeneration === this.talkPresentationGeneration &&
          ctx.Session.isVoicePlaybackScopeCurrent(voicePlaybackScopeVersion);
        // Every helper except EveryoneLipSync only releases the authored
        // targets. This permits another character's still-playing voice/mouth
        // to overlap the next speaker exactly as the native helper does.
        if (everyoneLipSyncMode) ctx.SceneRoot.stopAllSpeaking();
        else if (authoredLipTargets.length) ctx.SceneRoot.stopSpeaking(authoredLipTargets.filter(Boolean));
        if (!hasSemanticAdvText(cmd, localizedText) && !prefix.trim()) {
          clearTalkState(ctx.state);
          return;
        }
        if (!overlapVoices) ctx.SoundManager.stopVoices();
        const ignoreLip = truthy(cmd.ignoreLipSync);
        const playVoiceAudio = !ctx.Model.shouldShortCut;
        // Preserve source indices: voice.characterId and voiceRefs are parallel
        // arrays, so compacting one failed Howl shifts every later mouth target.
        const voiceEntriesByIndex = playVoiceAudio ? voices.map((voice) => ctx.SoundManager.playVoice(voice)) : [];
        const voiceEntries = voiceEntriesByIndex.filter(isPresent);
        const voicePlayIds = voiceEntries.map((entry) => entry.playId);
        const manualAdvanceGeneration = this.manualAdvanceGeneration;
        const everyoneLipSync = lipSyncMode === "everyonelipsync" && voiceEntries.length > 0;
        const airLipSync = lipSyncMode === "airlipsync";
        const holdOpenAirLipSync = lipSyncMode === "airlipsync_holdopen";
        const airLipOpening = finite(param(cmd, 1), 1) || 1;
        // PlayEveryoneLipSyncVoices ignores Episode.TargetName and fans the
        // first voice analyzer out to every currently showing character.
        const lipTargets = everyoneLipSync ? ctx.SceneRoot.showingCharacterTargets() : authoredLipTargets;
        const normalLipSyncSpeed = Math.abs(ctx.Model.getCurrentSpeedRate() - 1) < 0.001;
        if (playVoiceAudio && lipTargets.length && !ignoreLip && normalLipSyncSpeed) {
          // AirLipSync is the native timed-pseudo path, independent from the
          // voice analyzer as the active mode, but the controller keeps its
          // voice-player binding underneath and returns to it after the timed
          // overlay. HoldOpen uses the controller's separate fixed-opening
          // mode and its native smooth close tail.
          if (everyoneLipSync) {
            const firstVoiceIndex = voiceEntriesByIndex.findIndex(isPresent);
            const firstVoiceEntry = firstVoiceIndex >= 0 ? voiceEntriesByIndex[firstVoiceIndex] : null;
            const voiceDuration = maxSoundDurationSeconds(firstVoiceIndex >= 0 ? [voices[firstVoiceIndex]] : []);
            if (firstVoiceEntry) ctx.SceneRoot.startVoiceLipSync(lipTargets, [firstVoiceEntry], voiceDuration, 1, 1);
            if (holdOpenAirLipSync) {
              ctx.SceneRoot.startTimedHoldOpenPseudoLipSync(lipTargets, airLipOpening, text.text.length, 1);
            } else if (airLipSync) {
              ctx.SceneRoot.startTimedPseudoLipSync(lipTargets, text.text.length, 1, airLipOpening);
            }
          } else {
            for (let index = 0; index < lipTargets.length; index += 1) {
              const target = lipTargets[index];
              if (!target) continue;
              const voiceEntry = voiceEntriesByIndex[index];
              const voiceDuration = maxSoundDurationSeconds([voices[index]]);
              const voiceLipStarted = voiceEntry
                ? ctx.SceneRoot.startVoiceLipSync(target, [voiceEntry], voiceDuration, 1, 1)
                : false;
              if (holdOpenAirLipSync) {
                ctx.SceneRoot.startTimedHoldOpenPseudoLipSync(target, airLipOpening, text.text.length, 1);
              } else if (airLipSync) {
                ctx.SceneRoot.startTimedPseudoLipSync(target, text.text.length, 1, airLipOpening);
              } else if (!voiceLipStarted) {
                if (voiceDuration > 0) {
                  ctx.SceneRoot.startTimedPseudoLipSyncSeconds(target, voiceDuration, 1, 1);
                } else if (cmd.talkPresentation?.timedLipSyncWhenVoiceUnavailable) {
                  const authoredRate = Number(cmd.talkPresentation.textReveal?.unitsPerSecond);
                  const fallbackSeconds =
                    text.text.length / (Number.isFinite(authoredRate) && authoredRate > 0 ? authoredRate : 15);
                  ctx.SceneRoot.startTimedPseudoLipSyncSeconds(target, fallbackSeconds, 1, 1);
                } else {
                  ctx.SceneRoot.startTimedPseudoLipSync(target, text.text.length, 1, 1);
                }
              }
            }
          }
        }
        ctx.state.talk.sourceCommand = source;
        ctx.state.talk.prefixLength = prefix.length;
        ctx.state.talk.fontScale = Math.max(0.1, finite(cmd.talkPresentation?.fontScale, 1));
        ctx.state.talk.visible = true;
        ctx.state.talk.speaker = speaker.text;
        ctx.state.talk.speakerLang = speaker.lang;
        ctx.state.talk.text = text.text;
        ctx.state.talk.textLang = text.lang;
        ctx.state.talk.textFormat =
          typeof cmd.textFormat === "string" && cmd.textFormat.trim() ? cmd.textFormat.trim() : undefined;
        ctx.state.talk.textDisplayMode = typeof cmd.textDisplayMode === "boolean" ? cmd.textDisplayMode : undefined;
        ctx.state.talk.targetName = firstTarget(cmd);
        ctx.Session.addTalkLog({
          sourceCommand: ctx.state.talk.sourceCommand,
          speaker: speaker.text,
          speakerLang: speaker.lang,
          text: text.text,
          textLang: text.lang,
          textFormat: ctx.state.talk.textFormat,
          textDisplayMode: ctx.state.talk.textDisplayMode,
          commandIndex: cmd.index,
        });
        ctx.state.talkLog = [...ctx.Session.TalkLog];
        const preserveInstantAutoTiming = Boolean(
          this.state.instantText && cmd.talkPresentation?.preserveAutoAdvanceTimingWhenInstant,
        );
        await this.typeTalkText(
          text.text,
          presentationGeneration,
          commandSignal,
          ownsPresentation,
          cmd.talkPresentation,
          prefix,
        );
        if (!cmd.noWait && ownsPresentation() && manualAdvanceGeneration === this.manualAdvanceGeneration)
          await this.waitForReadableAdvance(
            cmd.talkPresentation?.autoAdvanceAfterTextReveal && !preserveInstantAutoTiming ? 0 : text.text.length,
            voicePlayIds,
            voicePlaybackScopeVersion,
            commandSignal,
            this.autoPlayIntervalSeconds,
          );
        if (
          cmd.talkPresentation?.stopVoicesOnManualAdvance &&
          manualAdvanceGeneration !== this.manualAdvanceGeneration
        ) {
          ctx.SoundManager.stopVoicePlaybacks(voicePlayIds);
        }
        if (cmd.hideTalkOnComplete && ownsPresentation()) ctx.state.talk.visible = false;
      });
    });

    register(ADV_COMMAND.Voice, (cmd, ctx, signal) => {
      return this.runCommandTask(cmd, async () => {
        const commandSignal = signal || this.abortController.signal;
        const voicePlaybackScopeVersion = ctx.Session.beginVoicePlaybackScope();
        ctx.SoundManager.stopVoices();
        ctx.SceneRoot.stopAllTimedPseudoLipSync();
        ctx.SceneRoot.stopAllSpeaking();
        if (ctx.Model.shouldShortCut || commandSignal.aborted) return;

        const voices = cmd.voices || [];
        const voiceEntriesByIndex = voices.map((voice) => ctx.SoundManager.playVoice(voice));
        const voiceEntries = voiceEntriesByIndex.filter(isPresent);
        const voicePlayIds = voiceEntries.map((entry) => entry.playId);
        const configuredTargets = Array.isArray(cmd.lipSyncTargets)
          ? cmd.lipSyncTargets.map((target) => String(target || ""))
          : [];
        const targets = configuredTargets.some(Boolean) ? configuredTargets : targetKeys(cmd);
        const normalLipSyncSpeed = Math.abs(ctx.Model.getCurrentSpeedRate() - 1) < 0.001;
        if (!truthy(cmd.ignoreLipSync) && normalLipSyncSpeed) {
          for (let index = 0; index < targets.length; index += 1) {
            const voiceEntry = voiceEntriesByIndex[index];
            if (!voiceEntry || !targets[index]) continue;
            ctx.SceneRoot.startVoiceLipSync(
              targets[index],
              [voiceEntry],
              maxSoundDurationSeconds([voices[index]]),
              1,
              1,
            );
          }
        }
        const scopeSignal = ctx.Session.voicePlaybackScopeSignal(voicePlaybackScopeVersion);
        if (!voicePlayIds.length || !scopeSignal) return;
        await ctx.SoundManager.waitForVoicePlayback(voicePlayIds, {
          signal: commandSignal,
          scopeSignal,
          isScopeCurrent: () => ctx.Session.isVoicePlaybackScopeCurrent(voicePlaybackScopeVersion),
        });
      });
    });

    register(ADV_COMMAND.Location, async (cmd, ctx, signal) => {
      if (!hasSemanticAdvText(cmd, localizedText)) {
        delete ctx.state.location.sourceText;
        ctx.state.location.text = "";
        ctx.state.location.lang = undefined;
        ctx.state.location.visible = false;
        return;
      }
      const text = localizedText(cmd.text || "");
      ctx.state.location.sourceText = clonePlain(cmd.text);
      ctx.state.location.text = text.text;
      ctx.state.location.lang = text.lang;
      ctx.state.location.visible = true;
      if (ctx.Model.shouldShortCut) {
        ctx.state.location.visible = false;
        return;
      }
      const hide = async () => {
        await delaySeconds(2.5, signal || this.abortController.signal);
        ctx.state.location.visible = false;
      };
      if (cmd.noWait) this.observeDetachedCommandTask(hide());
      else await hide();
    });

    register(ADV_COMMAND.Subtitles, async (cmd, ctx, signal) => {
      if (ctx.Model.shouldShortCut) {
        ctx.state.subtitles.visible = false;
        return;
      }
      if (!(ctx.state.video as Record<string, unknown>)?.src) return;
      if (!hasSemanticAdvText(cmd, localizedText)) {
        clearSubtitlesState(ctx.state.subtitles);
        return;
      }
      const text = localizedText(cmd.text || "");
      ctx.state.subtitles.sourceText = clonePlain(cmd.text);
      updateSubtitlesState(ctx.state.subtitles, text.text, text.lang, ctx.Model.isSubtitlesEnabled);
      if (cmd.noWait) return;
      if (ctx.Model.isAutoEnabled)
        await delaySeconds(
          finite(ctx.runtime.waitSubtitlesLingeringTimeOnAutoPlay, 0.1) / ctx.Model.getCurrentSpeedRate(),
          this.abortController.signal,
        );
      else await this.Model.waitForNext(signal || this.abortController.signal);
    });

    register(ADV_COMMAND.Bgm, async (cmd, ctx) => {
      const fade = ctx.Model.shouldShortCut ? 0 : soundFadeSeconds(cmd);
      if (this.seekIndexBuilding && this.seekSoundProjection) {
        if (cmd.bgm) {
          const sound = clonePlain(cmd.bgm);
          const label = sound.cueName || sound.cueSheetName || String(sound.soundId ?? sound.id ?? "");
          this.seekSoundProjection.bgm = sound;
          this.seekSoundProjection.bgmPositionSeconds = Math.max(0, finite(param(cmd, 1), 0));
          this.seekSoundProjection.bgmPlaying = true;
          this.seekSoundProjection.lastBgmLabel = label;
          this.seekSoundProjection.lastBgmOrSeFrame = this.seekSoundProjection.frameStamp;
          ctx.state.audio.bgm = label;
          ctx.Session.CurrentBgmPlayId = 1;
        } else {
          this.seekSoundProjection.bgm = null;
          this.seekSoundProjection.bgmPositionSeconds = 0;
          this.seekSoundProjection.bgmPlaying = false;
          this.seekSoundProjection.lastBgmLabel = "";
          ctx.state.audio.bgm = "";
          ctx.Session.CurrentBgmPlayId = 0;
        }
        return;
      }
      if (cmd.bgm) {
        const entry = ctx.SoundManager.playBgm(cmd.bgm, fade, finite(param(cmd, 1), 0));
        const playId = entry?.playId || 0;
        ctx.Session.CurrentBgmPlayId = playId;
        if (entry) {
          ctx.SoundManager.scheduleSoundAutoStop(
            entry,
            Math.max(0, finite(cmd.duration, 0)),
            Math.max(0, finite(param(cmd, 2), 0)),
            () => {
              if (ctx.Session.CurrentBgmPlayId === playId) ctx.Session.CurrentBgmPlayId = 0;
            },
          );
        }
      } else {
        ctx.SoundManager.stopBgm(fade);
        ctx.Session.CurrentBgmPlayId = 0;
      }
    });

    register(ADV_COMMAND.Se, (cmd, ctx, signal) => {
      if (ctx.Model.shouldShortCut) return;
      const rawSe = cmd.raw?.SeID ?? cmd.seId;
      const targetSe =
        cmd.se ??
        (typeof rawSe === "number"
          ? rawSe
          : typeof rawSe === "string" && rawSe.trim() !== "" && Number.isFinite(Number(rawSe))
            ? Number(rawSe)
            : undefined);
      const mode = String(param(cmd, 0) || "")
        .trim()
        .toLowerCase();
      const fadeOutSeconds = optionalFinite(param(cmd, 1), 0);
      const seDelaySeconds = optionalFinite(param(cmd, 2), 0);
      const play = () => {
        if (mode === "stop") {
          ctx.SoundManager.stopSe(targetSe, fadeOutSeconds, seDelaySeconds);
          return;
        }
        if (cmd.se) {
          ctx.SoundManager.playSe(cmd.se, {
            delaySeconds: seDelaySeconds,
            durationSeconds: commandDuration(ctx, cmd, 0),
            fadeOutSeconds,
          });
        }
      };
      // AdvSeCommand.Execute always calls PlaySeAsync(...).Forget(). Its
      // Episode.DelaySeconds is read inside PlaySeAsync, so even an authored
      // non-no-wait SE must never hold the story command stream.
      this.startDetachedCommandTask(async () => {
        const commandSignal = signal || this.abortController.signal;
        const delay = ctx.Model.calcDuration(finite(cmd.delaySeconds, 0), 0);
        if (delay > 0 && !(await ctx.Session.DelayTokens.delay(delay, commandSignal))) return;
        if (!this.disposed && !commandSignal.aborted && !ctx.Model.shouldShortCut) play();
      });
    });

    register(ADV_COMMAND.SoundVolume, async (cmd, ctx, signal) => {
      const duration = commandDuration(ctx, cmd, 0);
      if (this.seekIndexBuilding && this.seekSoundProjection) {
        const rawCategory = String(param(cmd, 0)).trim().toLowerCase();
        const category =
          rawCategory === "bgm" ? "Bgm" : rawCategory === "se" ? "Se" : rawCategory === "voice" ? "Voice" : "";
        if (category) {
          const volumes = new Map(this.seekSoundProjection.categoryVolumes);
          volumes.set(category, clamp01(param(cmd, 1), 1));
          this.seekSoundProjection.categoryVolumes = [...volumes.entries()];
        }
        return;
      }
      await this.runCommandTask(cmd, async () => {
        ctx.SoundManager.setCategoryVolume(param(cmd, 0), finite(param(cmd, 1), 1), duration);
        if (duration > 0) await delaySeconds(duration, signal || this.abortController.signal);
      });
    });

    register(ADV_COMMAND.FadeOut, (cmd, ctx, signal) => {
      return this.runCommandTask(cmd, async () => {
        const color = htmlColor(param(cmd, 0), "#000000");
        const duration = commandDuration(ctx, cmd, 0);
        const transitionGeneration = ++this.coverTransitionGeneration;
        const rule = cmd.ruleTransition || (ctx.runtime.defaultRuleTransition as AdvRuleTransitionEntry | undefined);
        if (rule && (rule.texture || rule.maskTexture || rule.gradient != null)) {
          await ctx.SceneRoot.runRuleTransition(rule, color, duration, true);
          ctx.SceneRoot.stopCommandEffects();
          ctx.state.effect = null;
          return;
        }
        const from = ctx.state.cover.opacity;
        await tween({
          duration,
          ease: resolveEase(param(cmd, 1), 6),
          signal: signal || this.abortController.signal,
          update: (t) => {
            if (transitionGeneration !== this.coverTransitionGeneration) return;
            ctx.state.cover.opacity = lerp(from, 1, t);
            ctx.SceneRoot.setCover(color, ctx.state.cover.opacity);
          },
        });
        if (
          this.disposed ||
          signal?.aborted ||
          this.abortController.signal.aborted ||
          transitionGeneration !== this.coverTransitionGeneration
        )
          return;
        ctx.state.cover.opacity = 1;
        ctx.SceneRoot.setCover(color, 1);
        ctx.SceneRoot.stopCommandEffects();
        ctx.state.effect = null;
      });
    });

    register(ADV_COMMAND.FadeIn, async (cmd, ctx, signal) => {
      const color = htmlColor(param(cmd, 0), ctx.state.cover.color || "#000000");
      const duration = commandDuration(ctx, cmd, 0);
      const transitionGeneration = ++this.coverTransitionGeneration;
      const rule = cmd.ruleTransition || (ctx.runtime.defaultRuleTransition as AdvRuleTransitionEntry | undefined);
      await this.runCommandTask(cmd, async () => {
        if (rule && (rule.texture || rule.maskTexture || rule.gradient != null)) {
          await ctx.SceneRoot.runRuleTransition(rule, color, duration, false);
          return;
        }
        const from = ctx.state.cover.opacity || 1;
        await tween({
          duration,
          ease: resolveEase(param(cmd, 1), 6),
          signal: signal || this.abortController.signal,
          update: (t) => {
            if (transitionGeneration !== this.coverTransitionGeneration) return;
            ctx.state.cover.opacity = lerp(from, 0, t);
            ctx.SceneRoot.setCover(color, ctx.state.cover.opacity);
          },
        });
        if (
          this.disposed ||
          signal?.aborted ||
          this.abortController.signal.aborted ||
          transitionGeneration !== this.coverTransitionGeneration
        )
          return;
        ctx.state.cover.opacity = 0;
        ctx.SceneRoot.setCover(color, 0);
      });
    });

    register(ADV_COMMAND.Flash, async (cmd, ctx) => {
      await this.runCommandTask(cmd, () => ctx.SceneRoot.flashWhite(commandDuration(ctx, cmd, 0.3)));
    });

    register(ADV_COMMAND.Focus, (cmd, ctx, signal) => {
      return this.runTransitionCommandTask(
        cmd,
        "focus",
        (transitionSignal) => {
          const targetName = firstTarget(cmd);
          const positionType =
            (cmd.positionType as number) || ctx.Session.tryGetTargetNameToPositionType(targetName) || 5;
          // Focus commits all camera-session state after its internal
          // DelaySeconds continuation resumes.
          ctx.Session.setCurrentFocusCameraDistance(cmd.cameraDistance ?? 0);
          syncPanV2BaseFromFocus(ctx, positionType, targetName, cmd.cameraDistance ?? 0);
          return ctx.SceneRoot.focus({
            positionType,
            targetName,
            cameraDistance: cmd.cameraDistance,
            duration: commandDuration(ctx, cmd, AdvCamera.defaultTweenDuration),
            ease: param(cmd, 1) || ctx.runtime.focusEase || 6,
            signal: transitionSignal,
          });
        },
        signal || this.abortController.signal,
      );
    });

    register(ADV_COMMAND.Zoom, (cmd, ctx, signal) => {
      return this.runTransitionCommandTask(
        cmd,
        "zoom",
        (transitionSignal) => {
          const targetRatio = AdvCamera.zoomCommandTargetRatio(ctx.Session.CurrentFocusCameraZoomRatio, param(cmd, 0));
          const rawBackgroundBlurOffset = param(cmd, 2);
          const backgroundBlurToken = String(rawBackgroundBlurOffset ?? "").trim();
          const preserveBackgroundBlur = backgroundBlurToken.toLowerCase() === "sharp";
          const backgroundBlurOffset =
            backgroundBlurToken === "" || preserveBackgroundBlur ? null : finite(rawBackgroundBlurOffset, 0);
          const focus = ctx.SceneRoot.closestFocusDataByZoomRatio(targetRatio);
          const cameraDistance = focus?.cameraDistance || 0;
          // Zoom's session distance write follows its internal DelaySeconds.
          ctx.Session.setCurrentFocusCameraDistance(cameraDistance);
          return ctx.SceneRoot.zoomByRatio(
            targetRatio,
            commandDuration(ctx, cmd, AdvCamera.defaultTweenDuration),
            param(cmd, 1) || ctx.runtime.focusEase || 6,
            backgroundBlurOffset,
            !preserveBackgroundBlur,
            transitionSignal,
          );
        },
        signal || this.abortController.signal,
      );
    });

    register(ADV_COMMAND.Pan, (cmd, ctx, signal) => {
      return this.runTransitionCommandTask(
        cmd,
        "pan",
        (transitionSignal) =>
          ctx.SceneRoot.setCharacterStagesY(
            finite(param(cmd, 0), 0),
            commandDuration(ctx, cmd, AdvCamera.defaultTweenDuration),
            param(cmd, 1) || 6,
            transitionSignal,
          ),
        signal || this.abortController.signal,
      );
    });

    register(ADV_COMMAND.PanV2, (cmd, ctx, signal) => {
      const rate =
        param(cmd, 2) === "" ? finite(ctx.runtime.defaultPanV2FocusSlideRate, 0.5) : finite(param(cmd, 2), 0.5);
      const rotationY = finite(param(cmd, 0), 0);
      return this.runTransitionCommandTask(
        cmd,
        "pan",
        (transitionSignal) => {
          if (transitionSignal.aborted) return;
          const distance = ctx.SceneRoot.panFocusDistance(ctx.Session.CurrentFocusCameraPosition);
          const offset = ctx.SceneRoot.panV2CameraOffset(rotationY, distance, rate);
          ctx.Session.setCurrentPanV2CameraOffset(offset as { x: number; y: number });
          return ctx.SceneRoot.panV2({
            rotationY,
            cameraOffset: offset,
            cameraDistance: ctx.Session.CurrentFocusCameraDistance,
            duration: commandDuration(ctx, cmd, AdvCamera.defaultTweenDuration),
            ease: param(cmd, 1) || 6,
            signal: transitionSignal,
          });
        },
        signal || this.abortController.signal,
      );
    });

    register(ADV_COMMAND.Angle, (cmd, ctx) => {
      const angle = finite(param(cmd, 0), 0);
      const bodyAngle = finite(param(cmd, 1), 0);
      const duration = commandDuration(ctx, cmd, 0);
      return this.runPreparedDelayedCommandTask(cmd, () => {
        const commits = targetKeys(cmd)
          .map((target) => ctx.SceneRoot.prepareCharacterAngle(target, angle, bodyAngle, duration))
          .filter((commit): commit is () => Promise<void> => Boolean(commit));
        if (!commits.length) return null;
        return () => Promise.all(commits.map((commit) => commit()));
      });
    });

    register(ADV_COMMAND.Tilt, (cmd, ctx, signal) => {
      return this.runTransitionCommandTask(
        cmd,
        "tilt",
        (transitionSignal) =>
          ctx.SceneRoot.setTilt(
            -finite(param(cmd, 0), 0),
            commandDuration(ctx, cmd, AdvCamera.defaultTweenDuration),
            param(cmd, 1) || 6,
            transitionSignal,
          ),
        signal || this.abortController.signal,
      );
    });

    register(ADV_COMMAND.Pedestal, (cmd, ctx, signal) => {
      const offsetY = finite(param(cmd, 0), 0);
      return this.runTransitionCommandTask(
        cmd,
        "pedestal",
        (transitionSignal) => {
          const targetBase = {
            x: finite(ctx.Session.CurrentPanV2BaseCameraPosition?.x, 0),
            y: finite(ctx.Session.CurrentFocusCameraPosition?.y, 0) + offsetY,
            z: finite(ctx.Session.CurrentPanV2BaseCameraPosition?.z, 0),
          };
          ctx.Session.setCurrentPanV2BaseCameraPosition(targetBase);
          return ctx.SceneRoot.setPanV2BaseCameraPosition(
            targetBase,
            commandDuration(ctx, cmd, AdvCamera.defaultTweenDuration),
            param(cmd, 1) || 6,
            transitionSignal,
          );
        },
        signal || this.abortController.signal,
      );
    });

    register(ADV_COMMAND.Track, (cmd, ctx, signal) => {
      return this.runTransitionCommandTask(
        cmd,
        "track",
        (transitionSignal) => {
          const offsetX = finite(param(cmd, 0), 0);
          const duration = commandDuration(ctx, cmd, AdvCamera.defaultTweenDuration);
          const ease = param(cmd, 1) || 6;
          const targetBase = {
            x: finite(ctx.Session.CurrentFocusCameraPosition?.x, 0) + offsetX,
            y: finite(ctx.Session.CurrentPanV2BaseCameraPosition?.y, 0),
            z: finite(ctx.Session.CurrentPanV2BaseCameraPosition?.z, 0),
          };
          const targetOffset = {
            x: 0,
            y: finite(ctx.Session.CurrentPanV2CameraOffset?.y, 0),
          };
          ctx.Session.setCurrentPanV2BaseCameraPosition(targetBase);
          ctx.Session.setCurrentPanV2CameraOffset(targetOffset);
          return Promise.all([
            ctx.SceneRoot.setPanV2BaseCameraPosition(targetBase, duration, ease, transitionSignal),
            ctx.SceneRoot.setPanV2CameraOffset(targetOffset, duration, ease, transitionSignal),
          ]);
        },
        signal || this.abortController.signal,
      );
    });

    register(ADV_COMMAND.Look, (cmd, ctx) => {
      const duration = commandDuration(ctx, cmd, 0);
      const lookX = finite(param(cmd, 0), 0);
      const lookY = finite(param(cmd, 1), 0);
      const enabled = String(param(cmd, 2)).trim().toLowerCase() !== "stop";
      return this.runPreparedDelayedCommandTask(cmd, () => {
        const commits = targetKeys(cmd)
          .map((target: string) => ctx.SceneRoot.prepareLook(target, lookX, lookY, duration, enabled))
          .filter((commit): commit is () => Promise<void> => Boolean(commit));
        if (!commits.length) return null;
        return () => Promise.all(commits.map((commit) => commit()));
      });
    });

    register(ADV_COMMAND.LookTarget, (cmd, ctx) => {
      const duration = commandDuration(ctx, cmd, 0);
      const enabled = String(param(cmd, 2)).trim().toLowerCase() !== "stop";
      const targetPositionType = Number(cmd.positionType) || 0;
      // Native resolves PositionType through AdvPlaybackSession before its
      // DelaySeconds await. The mapping intentionally includes controllers
      // hidden by Out, and the selected controller/head position is frozen for
      // the eventual tween rather than sampled again after the delay.
      const lookTargetName = ctx.Session.getCharacterAt(targetPositionType);
      return this.runPreparedDelayedCommandTask(cmd, () => {
        const commits = targetKeys(cmd)
          .map((target: string) =>
            ctx.SceneRoot.prepareLookTarget(target, targetPositionType, duration, enabled, lookTargetName),
          )
          .filter((commit): commit is () => Promise<void> => Boolean(commit));
        if (!commits.length) return null;
        return () => Promise.all(commits.map((commit) => commit()));
      });
    });

    register(ADV_COMMAND.Brightness, async (cmd, ctx) => {
      const targetName = firstTarget(cmd);
      const value = finite(param(cmd, 0), 1);
      const duration = commandDuration(ctx, cmd, 0);
      const positionType = Number(cmd.positionType) || 0;

      // AdvBrightness first asks the resource loader for TargetName. A mapped
      // loaded controller uses the renderer entry; only an unmapped loaded
      // controller takes the renderer brightness channel directly.
      if (targetName && ctx.SceneRoot.hasCharacterController(targetName)) {
        const mappedPosition = ctx.Session.tryGetTargetNameToPositionType(targetName);
        await this.runCommandTask(cmd, () =>
          mappedPosition
            ? ctx.SceneRoot.setRendererCharacterBrightness(targetName, value, duration, mappedPosition)
            : ctx.SceneRoot.setBrightness(targetName, value, duration),
        );
        return;
      }

      const layers = (cmd.canvasLayers || []).map(Number);
      if (layers.length) {
        const tasks: Array<() => Promise<void>> = [];
        for (const layer of layers) {
          if (layer === ADV_CANVAS_LAYER.Background) {
            tasks.push(() => ctx.SceneRoot.setBackgroundBrightness(value, duration));
          } else if (layer === ADV_CANVAS_LAYER.Character) {
            const positionTarget =
              ctx.Session.getCharacterAt(positionType) || ctx.SceneRoot.characterAtPosition(positionType)?.target || "";
            if (positionTarget) {
              tasks.push(() =>
                ctx.SceneRoot.setRendererCharacterBrightness(positionTarget, value, duration, positionType),
              );
            }
          }
        }
        await this.runCommandTask(cmd, () => Promise.all(tasks.map((task) => task())));
        return;
      }

      if (positionType) {
        const positionTarget =
          ctx.Session.getCharacterAt(positionType) || ctx.SceneRoot.characterAtPosition(positionType)?.target || "";
        // Native TryGetPositionTypeToCharacter failure is a strict no-op. In
        // particular it must never darken/brighten the background instead.
        if (!positionTarget) return;
        await this.runCommandTask(cmd, () =>
          ctx.SceneRoot.setRendererCharacterBrightness(positionTarget, value, duration, positionType),
        );
        return;
      }

      await this.runCommandTask(cmd, () => ctx.SceneRoot.setBackgroundBrightness(value, duration));
    });

    register(ADV_COMMAND.Shake, async (cmd, ctx, signal) => {
      const p1 = finite(param(cmd, 0), 1);
      const duration = commandDuration(ctx, cmd, 0);
      // DOTween refuses a zero-duration Shake and native exits before changing
      // the next-step state or touching any layer target.
      if (duration <= 0) return;
      const fieldStrength = p1 * finite(ctx.runtime.shakeFieldStrength, 0.1);
      const uiStrength = p1 * finite(ctx.runtime.shakeUIStrength, 10);
      // The target tweens are independent Forget() tasks. A tap only completes
      // WaitShakeTask; it must not kill/reset the still-fading visual shake.
      this.observeDetachedCommandTask(
        ctx.SceneRoot.shakeCommand(fieldStrength, uiStrength, duration, 10, 90, true, cmd.canvasLayers),
      );
      if (cmd.noWait) return;

      this.cancelShakeWait();
      const controller = createAbortLink(this.abortController.signal, signal);
      this.shakeWaitController = controller;
      // ChangeAllowNextState precedes UniTask.WaitUntil(IsNextStepGoNext), so a
      // stale GoNext flag from the preceding command cannot consume this wait.
      ctx.Model.changeAllowNextState();
      try {
        await Promise.race([
          this.delayWithSpeedAdjustment(duration, controller.signal),
          ctx.Model.waitForNext(controller.signal),
        ]);
      } finally {
        if (this.shakeWaitController === controller) this.shakeWaitController = null;
        controller.abort();
      }
    });

    register(ADV_COMMAND.CameraShake, async (cmd, ctx) => {
      const parameterFade = finite(param(cmd, 0), 0);
      const fadeDuration = parameterFade > 0 ? ctx.Model.calcDuration(parameterFade, 0) : commandDuration(ctx, cmd, 0);
      if (ctx.SceneRoot.isCameraShakePlaying()) {
        await this.runCommandTask(cmd, () => ctx.SceneRoot.disableCameraShake(fadeDuration));
        return;
      }
      const parameterStrength = finite(param(cmd, 1), 0);
      await this.runCommandTask(cmd, () =>
        ctx.SceneRoot.enableCameraShake(
          parameterStrength > 0 ? parameterStrength : finite(ctx.runtime.cameraShakeStrength, 0.04),
          finite(ctx.runtime.cameraShakeDuration, 1),
          finite(ctx.runtime.cameraShakeVibrato, 2),
          finite(ctx.runtime.cameraShakeRandomness, 60),
          fadeDuration,
        ),
      );
    });

    const movement =
      (
        dx: (cmd: AdvCommand) => number,
        dy: (cmd: AdvCommand) => number,
        dz: (cmd: AdvCommand) => number,
      ): AdvCommandHandler =>
      async (cmd: AdvCommand, ctx: AdvCommandContext) => {
        const worldTransition = cmd.characterWorldTransition;
        const worldDestination = worldTransition?.to ?? cmd.characterWorldPosition;
        if (worldDestination) {
          const target = firstTarget(cmd);
          if (!target) return;
          const positionType = Number(cmd.positionType) || ctx.Session.tryGetTargetNameToPositionType(target) || 5;
          ctx.Session.placeCharacter(target, positionType);
          playCharacterPresentation(cmd, ctx, target);
          if (worldTransition?.from) {
            void ctx.SceneRoot.moveCharacterToWorld(target, worldTransition.from, positionType, 0, 6);
          }
          await this.runCommandTask(cmd, () =>
            ctx.SceneRoot.moveCharacterToWorld(target, worldDestination, positionType, commandDuration(ctx, cmd, 0), 6),
          );
          return;
        }
        await this.runCommandTask(cmd, () =>
          ctx.SceneRoot.moveCharacter(
            cmd.positionType ?? 0,
            { x: dx(cmd), y: dy(cmd), z: dz(cmd) },
            commandDuration(ctx, cmd, 0),
            6,
          ),
        );
      };
    register(
      ADV_COMMAND.MoveToRight,
      movement(
        (cmd) => finite(param(cmd, 0), 1),
        () => 0,
        () => 0,
      ),
    );
    register(
      ADV_COMMAND.MoveToLeft,
      movement(
        (cmd) => -finite(param(cmd, 0), 1),
        () => 0,
        () => 0,
      ),
    );
    register(
      ADV_COMMAND.MoveToUp,
      movement(
        () => 0,
        (cmd) => finite(param(cmd, 0), 1),
        () => 0,
      ),
    );
    register(
      ADV_COMMAND.MoveToDown,
      movement(
        () => 0,
        (cmd) => -finite(param(cmd, 0), 1),
        () => 0,
      ),
    );
    register(
      ADV_COMMAND.MoveToForward,
      movement(
        () => 0,
        () => 0,
        (cmd) => -finite(param(cmd, 0), 1),
      ),
    );
    register(
      ADV_COMMAND.MoveToBack,
      movement(
        () => 0,
        () => 0,
        (cmd) => finite(param(cmd, 0), 1),
      ),
    );
    register(
      ADV_COMMAND.MoveToDirection,
      movement(
        (cmd) => finite(param(cmd, 0), 0),
        (cmd) => finite(param(cmd, 1), 0),
        (cmd) => finite(param(cmd, 2), 0),
      ),
    );
    register(ADV_COMMAND.Forward, async (cmd, ctx) => {
      ctx.SceneRoot.setCharacterForward(finite(cmd.positionType, 0));
    });
    register(ADV_COMMAND.Back, async (cmd, ctx) => {
      ctx.SceneRoot.setCharacterBack(finite(cmd.positionType, 0));
    });

    register(ADV_COMMAND.Still, async (cmd, ctx) => {
      const duration = ctx.Model.calcDuration(finite(param(cmd, 0), 0), 0);
      const rawStillAlpha = finite(param(cmd, 1), 0);
      const stillAlpha = rawStillAlpha > 0 ? clamp01(rawStillAlpha) : 1;
      const animationIndex = Math.max(0, Math.trunc(finite(param(cmd, 2), 0)));
      const overlayAlpha = clamp01(param(cmd, 3));
      await this.runCommandTask(cmd, () =>
        ctx.SceneRoot.runStillCommand(cmd.still, stillAlpha, overlayAlpha, animationIndex, duration),
      );
    });

    register(ADV_COMMAND.Alpha, async (cmd, ctx) => {
      const alpha = finite(param(cmd, 0), 1);
      const duration = commandDuration(ctx, cmd, 0);
      const layers = cmd.canvasLayers || [];
      const tasks: Promise<void>[] = [];
      if (layers.includes(7)) tasks.push(ctx.SceneRoot.fadeStill(alpha, duration));
      if (layers.includes(6)) tasks.push(ctx.SceneRoot.fadeVideo(alpha, duration));
      if (layers.includes(2))
        for (const target of targetKeys(cmd)) tasks.push(ctx.SceneRoot.fadeCharacter(target, alpha, duration));
      await this.runCommandTask(cmd, () => Promise.all(tasks));
    });

    register(ADV_COMMAND.Wait, async (_cmd, ctx, signal) => {
      if (ctx.Model.shouldShortCut) return;
      if (ctx.Model.isAutoEnabled) {
        const seconds = finite(ctx.runtime.waitCommandLingeringTimeOnAutoPlay, 2) / ctx.Model.getCurrentSpeedRate();
        await delaySeconds(seconds, signal || this.abortController.signal);
      } else {
        await this.Model.waitForNext(signal || this.abortController.signal);
      }
    });

    register(ADV_COMMAND.Delay, async (cmd, ctx) => {
      const sec = ctx.Model.calcDuration(finite(cmd.duration, 0), 0);
      if (sec <= 0) return;
      await ctx.Session.DelayTokens.delay(sec, this.abortController.signal);
    });

    register(ADV_COMMAND.CancelDelay, async (_cmd, ctx) => {
      ctx.Session.DelayTokens.cancel();
    });

    register(ADV_COMMAND.ForceAuto, async (_cmd, ctx) => {
      ctx.Model.switchForceAutoPlay();
      ctx.state.autoPlay = ctx.Model.isAutoEnabled;
    });

    // The original command body returns UniTask.CompletedTask without reading
    // its episode record. Choice data is loaded by ChoiceShow instead.
    register(ADV_COMMAND.ChoiceSet, () => {});

    register(ADV_COMMAND.ChoiceShow, async (cmd, ctx, signal) => {
      if (this.seekIndexBuilding) {
        const selected = this.seekChoice(cmd);
        if (!selected) return;
        ctx.Session.choiceRecords.set(selected.decisionIndex, selected.choice.record);
        ctx.state.choices.visible = false;
        ctx.state.choices.items = [];
        this.goToEpisodeKey(selected.choice.nextKey);
        return;
      }
      // Ordinary shortcut replay is retained for backwards compatibility;
      // exact progress seeking never enters this branch.
      if (ctx.Model.shouldShortCut) return;
      const choiceIndex = choiceInteger(param(cmd, 0), "choiceIndex");
      const choices = choiceItems(cmd, choiceIndex, this.narrativeStore.variables, localizedText);
      ctx.state.choices.items = choices;
      ctx.state.choices.visible = true;
      const waitSignal = signal || this.abortController.signal;
      let select: ((key: unknown) => void) | null = null;
      const randomChoiceController = createAbortLink(waitSignal);
      if (ctx.Model.isRandomChoice && ctx.Model.isAutoPlay) {
        const selectableChoices = choices.filter((choice) => choice.enabled !== false);
        void delaySeconds(1, randomChoiceController.signal)
          .then(() => {
            if (randomChoiceController.signal.aborted || !selectableChoices.length) return;
            const index = Math.floor(Math.random() * selectableChoices.length);
            this.choose(selectableChoices[index]?.key);
          })
          .catch(() => {});
      }
      const key = await new Promise<unknown>((resolve) => {
        let settled = false;
        const settle = (value: unknown) => {
          if (settled) return;
          settled = true;
          waitSignal.removeEventListener("abort", abort);
          if (this.choiceResolver === select) this.choiceResolver = null;
          resolve(value);
        };
        const abort = () => settle(ABORTED_CHOICE);
        select = settle;
        this.choiceResolver?.(ABORTED_CHOICE);
        this.choiceResolver = select;
        waitSignal.addEventListener("abort", abort, { once: true });
        if (this.disposed || waitSignal.aborted) abort();
      });
      randomChoiceController.abort();
      if (key === ABORTED_CHOICE || this.disposed || waitSignal.aborted) {
        ctx.state.choices.visible = false;
        ctx.state.choices.items = [];
        return;
      }
      const choice = choices.find((item) => item.key === key);
      if (!choice) {
        ctx.state.choices.visible = false;
        ctx.state.choices.items = [];
        throw new RangeError(`ADV ChoiceShow received an unknown choice key: ${String(key)}`);
      }
      // Native OnChoiceSelected: notify, hide, branch, mark GoNext, unlock.
      const decisionIndex = Number.isSafeInteger(Number(cmd.index)) ? Number(cmd.index) : choiceIndex;
      const decisionOrder = [...ctx.Session.choiceRecords.keys()];
      const replacedDecision = decisionOrder.indexOf(decisionIndex);
      if (replacedDecision >= 0) {
        for (const staleDecision of decisionOrder.slice(replacedDecision + 1)) {
          ctx.Session.choiceRecords.delete(staleDecision);
        }
      }
      ctx.Session.choiceRecords.set(decisionIndex, choice.record);
      ctx.state.choices.visible = false;
      ctx.state.choices.items = [];
      this.goToEpisodeKey(choice.nextKey);
      ctx.Model.changeGoNextState();
      await ctx.Model.waitForNext(waitSignal);
    });

    register(ADV_COMMAND.GoTo, async (cmd) => {
      if (this.Model.shouldShortCut && !this.seekIndexBuilding) return;
      this.goToEpisodeKey(param(cmd, 0));
    });

    register(ADV_COMMAND.ChatWindow, async (cmd, ctx, signal) => {
      const commandSignal = signal || this.abortController.signal;
      const screenMode = Math.max(0, Math.trunc(finite(param(cmd, 1), 0)));
      const batteryParameter = param(cmd, 0);
      // The paired closing command is normally consumed by the hide branch
      // below. Keep JavaScript's Number("") coercion from leaking a fabricated
      // 0% battery if state restoration or a seek reaches this path directly.
      const battery = String(batteryParameter ?? "").trim() ? finite(batteryParameter, NaN) : NaN;
      const windowKey = chatWindowKey(cmd);
      const memoryId = chatWindowMemoryId(cmd, windowKey);
      const participants = chatParticipantToken(cmd.targetName);
      const windowAssetName = chatWindowAssetName(cmd, ctx.runtime);
      const master = resolveAdvChatMaster(cmd.targetChatID, ctx.runtime);
      const wasVisible = Boolean(ctx.state.chat.visible);
      const sameThread = Boolean(
        wasVisible && ctx.state.chat.windowKey === windowKey && ctx.state.chat.memoryId === memoryId,
      );
      const finishTransition = async (task: Promise<void>): Promise<void> => {
        // AdvChatWindowCommand.Execute.MoveNext: authored IsNoWait forgets
        // PlayChatWindow only during normal playback. Shortcut replay still
        // awaits it, while Show/Hide receive shouldShortcut=true.
        if (cmd.noWait && !this.Model.shouldShortCut) {
          this.observeDetachedCommandTask(task);
          return;
        }
        await task;
      };
      if (sameThread && Number(ctx.state.chat.screenMode || 0) === screenMode) {
        // UIAdvChatWidget.PlayChatWindow toggles an already-active identical
        // window through HideChatWindowAsync when TrySetChatWindow returns
        // false. The paired ChatWindow rows at the end of every phone scene
        // rely on this branch to leave the phone surface.
        this.cancelChatTyping();
        beginHideChatWindow(ctx);
        const transition = delaySeconds(
          advChatWindowTransitionSeconds("hide", this.Model.getCurrentSpeedRate(), this.Model.shouldShortCut),
          commandSignal,
        ).then(() => {
          if (this.disposed || commandSignal.aborted || ctx.state.chat.visible) return;
          clearHiddenChatWindowAssets(ctx);
        });
        await finishTransition(transition);
        return;
      }
      ctx.state.chat.screenMode = screenMode;
      const title = chatWindowDisplayName(cmd, ctx.runtime, localizedText);
      ctx.state.chat.sourceCommand = presentationSource(cmd);
      ctx.state.chat.title = title.text;
      ctx.state.chat.titleLang = title.lang;
      ctx.state.chat.chatId = cmd.targetChatID || 0;
      ctx.state.chat.participants = participants;
      ctx.state.chat.windowKey = windowKey;
      ctx.state.chat.memoryId = memoryId;
      ctx.state.chat.windowAssetName = windowAssetName;
      ctx.state.chat.dataRoot = chatDataRootForWindowAsset(windowAssetName, ctx.runtime);
      ctx.state.chat.iconAssetName = master?.chatIconAssetName || "";
      ctx.state.chat.group = isGroupChatParticipants(participants);
      if (Number.isFinite(battery)) {
        ctx.state.chat.battery = battery;
        ctx.state.chat.batteryText = `${Math.round(battery as number)}%`;
      }
      ctx.Session.CurrentChatWindowScreenMode = screenMode;
      ctx.Session.CurrentChatMemoryId = memoryId;
      ctx.state.chat.visible = true;
      if (!sameThread) {
        this.cancelChatTyping();
        ctx.state.chat.typing = "";
        ctx.state.chat.typingLang = undefined;
        ctx.state.chat.readVisible = false;
        ctx.state.chat.messages = restoreChatMessages(ctx, memoryId);
        this.refreshLocalizedPresentation();
      }
      const transition = delaySeconds(
        advChatWindowTransitionSeconds("show", this.Model.getCurrentSpeedRate(), this.Model.shouldShortCut),
        commandSignal,
      );
      await finishTransition(transition);
      if (screenMode > 0 && !cmd.noWait && !ctx.Model.shouldShortCut && !commandSignal.aborted) {
        // Non-chat phone surfaces (notification/incoming-call modes) are the
        // interaction themselves. The following command represents the tap
        // that dismisses or opens them, so normal playback must not run it in
        // the same frame. Ordinary screenMode=0 message windows are gated by
        // ChatTalk/ChatStamp instead.
        await this.waitForChatRead(0, 0, commandSignal);
      }
    });

    register(ADV_COMMAND.ChatTalk, (cmd, ctx, signal) => {
      return this.runCommandTask(cmd, async () => {
        const memoryId = chatCommandMemoryId(
          cmd,
          ctx.Session.CurrentChatMemoryId || "",
          Boolean(ctx.state.chat.visible),
        );
        const senderChatId = cmd.targetChatID || 0;
        const sender = targetDisplayName(cmd, ctx.runtime, localizedText);
        const text = commandText(cmd, "", localizedText);
        const soundInfos: AdvSoundEntry[] = cmd.voices || [];
        const voicePlaybackScopeVersion = ctx.Session.beginVoicePlaybackScope();
        ctx.SoundManager.stopVoices();
        const voiceEntries = ctx.Model.shouldShortCut
          ? []
          : soundInfos.map((voice) => ctx.SoundManager.playVoice(voice)).filter(isPresent);
        const voicePlayIds = voiceEntries.map((entry) => entry.playId);
        const readCount = Math.max(0, Math.trunc(finite(param(cmd, 0), 0)));
        const self = chatSenderIsSelf(ctx.state.chat.participants, cmd.targetName) || firstTarget(cmd).startsWith("my");
        const iconAsset = chatIconAssetName(cmd, ctx.runtime, (cmd.targetAssetName as string) || "");
        ctx.Session.chatMemoryAddTalk(
          memoryId,
          senderChatId,
          text.text,
          sender.text,
          readCount,
          text.lang,
          sender.lang,
        );
        const entries = ctx.Session.getOrCreateChatMemoryState(memoryId).entries;
        entries[entries.length - 1].sourceCommand = presentationSource(cmd);
        entries[entries.length - 1].self = self;
        entries[entries.length - 1].icon = iconAsset;
        entries[entries.length - 1].iconAssetName = iconAsset;
        if (!visibleChatMemory(ctx, memoryId)) return;
        this.cancelChatTyping();
        ctx.state.chat.messages.push({
          sourceCommand: presentationSource(cmd),
          id: `${cmd.index}`,
          speaker: sender.text,
          speakerLang: sender.lang,
          text: text.text,
          textLang: text.lang,
          self,
          readCount,
          icon: iconAsset,
          iconAssetName: iconAsset,
          iconChatId: senderChatId,
        });
        if (ctx.SoundManager && cmd.chatSound && !ctx.Model.shouldShortCut) ctx.SoundManager.playSe(cmd.chatSound);
        if (!cmd.noWait)
          await this.waitForReadableAdvance(
            text.text.length,
            voicePlayIds,
            voicePlaybackScopeVersion,
            signal || this.abortController.signal,
            0,
          );
      });
    });

    register(ADV_COMMAND.ChatTyping, (cmd, ctx, signal) => {
      return this.runCommandTask(cmd, async () => {
        const memoryId = chatCommandMemoryId(
          cmd,
          ctx.Session.CurrentChatMemoryId || "",
          Boolean(ctx.state.chat.visible),
        );
        if (!visibleChatMemory(ctx, memoryId)) return;
        ctx.state.chat.typingSource = clonePlain(cmd.text);
        const text = chatTypingText(cmd, localizedText);
        const typedLength = await this.typeChatTypingText(
          text.text,
          text.lang,
          memoryId,
          ctx,
          signal || this.abortController.signal,
        );
        if (ctx.Model.shouldShortCut) return;
        if (cmd.noWait) return;
        await this.waitForChatRead(typedLength, 0, signal || this.abortController.signal);
      });
    });

    register(ADV_COMMAND.ChatRead, (cmd, ctx, signal) => {
      return this.runCommandTask(cmd, async () => {
        const memoryId = chatCommandMemoryId(
          cmd,
          ctx.Session.CurrentChatMemoryId || "",
          Boolean(ctx.state.chat.visible),
        );
        const readCount = Math.max(0, Math.trunc(finite(param(cmd, 0), 0)));
        ctx.Session.chatMemoryApplyRead(memoryId, cmd.targetChatID || 0, readCount);
        if (!visibleChatMemory(ctx, memoryId)) return;
        ctx.state.chat.readVisible = true;
        const readApplied = Math.max(1, readCount);
        for (const msg of ctx.state.chat.messages)
          if (msg.self) {
            msg.read = true;
            msg.readCount = Math.max(finite(msg.readCount, 0), readApplied);
          }
        if (!cmd.noWait) await this.waitForChatRead(0, 0, signal || this.abortController.signal);
      });
    });

    register(ADV_COMMAND.ChatStamp, (cmd, ctx, signal) => {
      return this.runCommandTask(cmd, async () => {
        const memoryId = chatCommandMemoryId(
          cmd,
          ctx.Session.CurrentChatMemoryId || "",
          Boolean(ctx.state.chat.visible),
        );
        const senderChatId = cmd.targetChatID || 0;
        const sender = targetDisplayName(cmd, ctx.runtime, localizedText);
        const stampAsset = (cmd.targetAssetName as string) || "stamp";
        const readCount = Math.max(0, Math.trunc(finite(param(cmd, 0), 0)));
        const self = chatSenderIsSelf(ctx.state.chat.participants, cmd.targetName) || firstTarget(cmd).startsWith("my");
        const iconAsset = chatIconAssetName(cmd, ctx.runtime);
        ctx.Session.chatMemoryAddStamp(memoryId, senderChatId, stampAsset, sender.text, readCount, sender.lang);
        const entries = ctx.Session.getOrCreateChatMemoryState(memoryId).entries;
        entries[entries.length - 1].sourceCommand = presentationSource(cmd);
        entries[entries.length - 1].self = self;
        entries[entries.length - 1].icon = iconAsset;
        entries[entries.length - 1].iconAssetName = iconAsset;
        if (!visibleChatMemory(ctx, memoryId)) return;
        this.cancelChatTyping();
        ctx.state.chat.messages.push({
          sourceCommand: presentationSource(cmd),
          id: `${cmd.index}-stamp`,
          speaker: sender.text,
          speakerLang: sender.lang,
          stamp: stampAsset,
          self,
          readCount,
          icon: iconAsset,
          iconAssetName: iconAsset,
          iconChatId: senderChatId,
        });
        if (!cmd.noWait) await this.waitForChatRead(0, 0, signal || this.abortController.signal);
      });
    });

    register(ADV_COMMAND.Movie, async (cmd, ctx, signal) => {
      const movie = cmd.video || cmd.movie;
      const src = localPlaybackUrl(movie?.playableUrl || movie?.src || movie?.url, "video");
      if (!src) return;
      if (ctx.Model.shouldShortCut) {
        await ctx.SceneRoot.hideVideo(0);
        ctx.Session.VideoPlaying = false;
        return;
      }
      const fadeIn = ctx.Model.calcDuration(finite(param(cmd, 0), 0), 0);
      const fadeOut = ctx.Model.calcDuration(finite(param(cmd, 1), 0), 0);
      const playbackRate = ctx.Model.getCurrentSpeedRate();
      const videoInfo = movie ? { ...movie, playableUrl: src, src } : src;
      ctx.state.talk.visible = false;
      ctx.Session.setMovieSoundVolume(0);
      ctx.SoundManager.setMovieSoundVolume(0);
      try {
        await ctx.SceneRoot.showVideo(videoInfo, fadeIn, 0, playbackRate, signal);
        await ctx.SceneRoot.waitVideoEnded(signal);
        if (ctx.Model.isAutoEnabled) {
          await delaySeconds(
            finite(ctx.runtime.waitVideoLingeringTimeOnAutoPlay, 0.3) / ctx.Model.getCurrentSpeedRate(),
            signal || this.abortController.signal,
          );
        }
        await ctx.SceneRoot.hideVideo(fadeOut);
      } finally {
        ctx.Session.setMovieSoundVolume(1);
        ctx.SoundManager.setMovieSoundVolume(1);
      }
    });

    register(ADV_COMMAND.Clip, async (cmd, ctx, signal) => {
      const clip = cmd.video || cmd.clip;
      const src = localPlaybackUrl(clip?.playableUrl || clip?.src || clip?.url, "video");
      const fade = ctx.Model.calcDuration(finite(param(cmd, 0), 0), 0);
      if (ctx.Model.shouldShortCut) {
        this.cancelClipPlaybackWatch();
        await ctx.SceneRoot.hideVideo(0);
        ctx.Session.CurrentVideoInfo = null;
        ctx.Session.VideoPlaying = false;
        ctx.Session.FlowParameters.setClipVideoPlaying(false);
        ctx.Session.FlowParameters.setClipSkip(false);
        return;
      }

      const hasVideoId = hasAuthoredVideoId(cmd, src);
      if (hasVideoId && !ctx.Session.VideoPlaying) {
        if (!src) throw new Error(`ADV clip video ${String(cmd.videoId)} has no resolved local asset`);
        const alpha = clamp01(param(cmd, 1), 1);
        const videoInfo = clip ? { ...clip, playableUrl: src, src } : src;
        this.cancelClipPlaybackWatch();
        ctx.Session.CurrentVideoInfo = videoInfo;
        ctx.Session.VideoPlaying = true;
        ctx.Session.FlowParameters.setClipVideoPlaying(true);
        try {
          await ctx.SceneRoot.showVideo(videoInfo, fade, 0, ctx.Model.getCurrentSpeedRate(), signal, alpha);
        } catch (error) {
          if (ctx.Session.CurrentVideoInfo === videoInfo) {
            ctx.Session.CurrentVideoInfo = null;
            ctx.Session.VideoPlaying = false;
            ctx.Session.FlowParameters.setClipVideoPlaying(false);
          }
          throw error;
        }
        if (this.disposed || signal?.aborted || ctx.Session.CurrentVideoInfo !== videoInfo) return;
        this.watchClipPlaybackCompletion(videoInfo);
        return;
      }

      if (!hasVideoId && isSkipClipTarget(param(cmd, 2))) ctx.Session.FlowParameters.setClipSkip(false);
      if (ctx.Model.isAutoEnabled) {
        await this.delayWithSpeedAdjustment(
          finite(ctx.runtime.waitVideoLingeringTimeOnAutoPlay, 0.3) / ctx.Model.getCurrentSpeedRate(),
          signal || this.abortController.signal,
        );
      }
      this.cancelClipPlaybackWatch();
      await ctx.SceneRoot.hideVideo(fade);
      ctx.Session.CurrentVideoInfo = null;
      ctx.Session.VideoPlaying = false;
      ctx.Session.FlowParameters.setClipVideoPlaying(false);
      ctx.Session.FlowParameters.setClipSkip(false);
    });

    register(ADV_COMMAND.PostEffect, async (cmd, ctx) => {
      if (!ctx.QualityConfig.isStagePostEffectEnabled()) return;
      const name = (cmd.targetAssetName as string) || cmd.postEffect?.name || "";
      const profile = cmd.postEffect ? { ...cmd.postEffect, name } : name;
      const parameterFade = ctx.Model.calcDuration(finite(param(cmd, 0), 0), 0);
      const fade = parameterFade > 0 ? parameterFade : finite(cmd.duration, 0);
      ctx.state.postEffect = profile;
      // AdvPostEffectCommand.Execute returns CompletedTask immediately after
      // ToggleVolume; ToggleVolume itself calls Forget(). The authored fade
      // therefore overlaps following Delay/Stage commands regardless of IsNoWait.
      this.observeDetachedCommandTask(Promise.resolve().then(() => ctx.SceneRoot.setCommandPostEffect(profile, fade)));
    });

    register(ADV_COMMAND.DoF, (cmd, ctx, signal) => {
      const intensity = finite(param(cmd, 0), cmd.dofActive ? 1 : 0);
      const duration = commandDuration(ctx, cmd, 0);
      const ease = param(cmd, 1) || 6;
      const commandSignal = signal || this.abortController.signal;
      const delay = ctx.Model.shouldShortCut ? 0 : ctx.Model.calcDuration(finite(cmd.delaySeconds, 0), 0);
      const layerTargets = new Set(advDoFTargets(cmd.canvasLayers));
      const prepared: Array<() => Promise<boolean>> = [];

      // Both native helpers perform quality/target resolution first, refresh
      // their DoF-specific CTS second, and only then enter the shared delay.
      // A disabled/unresolved layer therefore completes immediately.
      if (layerTargets.has("background") && ctx.QualityConfig.isBackgroundBlurEnabled()) {
        const owner = this.refreshBackgroundDoFCommandController(commandSignal);
        prepared.push(async () => {
          try {
            if (delay > 0) {
              const completed = await ctx.Session.DelayTokens.delay(delay, owner.signal);
              if (!completed || owner.signal.aborted || this.disposed) return false;
            }
            await ctx.SceneRoot.setBackgroundDoF(intensity, duration, ease, owner.signal);
            return !owner.signal.aborted;
          } finally {
            this.releaseBackgroundDoFCommandController(owner);
          }
        });
      }

      if (layerTargets.has("character") && ctx.QualityConfig.isCharacterBlurEnabled()) {
        const authoredPosition = Number(cmd.positionType) || 0;
        const routes: Array<{ target: string; positionType: number }> = [];
        if (authoredPosition) {
          const target =
            ctx.Session.getCharacterAt(authoredPosition) ||
            ctx.SceneRoot.characterAtPosition(authoredPosition)?.target ||
            "";
          if (target) routes.push({ target, positionType: authoredPosition });
        } else {
          for (const target of targetKeys(cmd)) {
            const positionType = ctx.Session.tryGetTargetNameToPositionType(target);
            if (positionType) routes.push({ target, positionType });
          }
        }

        for (const route of routes) {
          const owner = this.refreshCharacterDoFCommandOwner(route.positionType, route.target, commandSignal);
          prepared.push(async () => {
            try {
              if (delay > 0) {
                const completed = await ctx.Session.DelayTokens.delay(delay, owner.controller.signal);
                if (!completed || owner.controller.signal.aborted || this.disposed) return false;
              }
              // The native continuation retains only PositionType across the
              // Delay await. Re-resolve the slot now so an intervening Out/In
              // applies blur to the new renderer entry, not the old target.
              const committedTarget =
                ctx.Session.getCharacterAt(route.positionType) ||
                ctx.SceneRoot.characterAtPosition(route.positionType)?.target ||
                "";
              if (!committedTarget) return false;
              owner.target = committedTarget;
              await ctx.SceneRoot.setCharacterDoF(committedTarget, intensity, duration, ease, owner.controller.signal);
              return !owner.controller.signal.aborted;
            } finally {
              this.releaseCharacterDoFCommandOwner(route.positionType, owner);
            }
          });
        }
      }

      if (!prepared.length) return;
      return this.runCommandTask(cmd, async () => {
        const committed = await Promise.all(prepared.map((task) => task()));
        if (committed.some(Boolean)) ctx.state.dofActive = Boolean(cmd.dofActive);
      });
    });

    register(ADV_COMMAND.Effect, async (cmd, ctx) => {
      if (!ctx.QualityConfig.isStageParticleEffectEnabled()) return;
      const asset = cmd.effect || null;
      const atOnce =
        String(param(cmd, 0) || "")
          .trim()
          .toLowerCase() === "atonce";
      const simulationSpeed = ctx.Model.getCurrentSpeedRate();
      const key = String(cmd.targetName || "");
      if (!key) throw new Error("ADV effect command has no target key");
      const stopping = ctx.SceneRoot.isCommandEffectPlaying(key);
      ctx.state.effect = stopping ? null : asset;
      const effectStates =
        ctx.state.effects && typeof ctx.state.effects === "object"
          ? (ctx.state.effects as Record<string, unknown>)
          : ((ctx.state.effects = {}) as Record<string, unknown>);
      if (stopping) delete effectStates[key];
      else effectStates[key] = asset;
      // AdvEffectCommand toggles the prefab identified by TargetName. Its
      // authored ParticleSystem/SpriteRenderer graph is always dispatched to
      // the shared Unity effect runtime; Parameter1 only selects stop mode.
      this.observeDetachedCommandTask(
        ctx.SceneRoot.playCommandEffect(asset, {
          atOnce,
          simulationSpeed,
          positionType: cmd.positionType,
          targetName: key,
          canvasLayers: cmd.canvasLayers,
        }),
      );
    });

    register(ADV_COMMAND.TalkWindow, async (cmd, ctx) => {
      ctx.state.talk.window = cmd.talkWindow || "default";
    });

    register(ADV_COMMAND.StageEnv, async (cmd, ctx) => {
      const envType = stageEnvType(param(cmd, 0));
      const requestedIndex = tryParseInt32(param(cmd, 1)) ?? 0;
      const focusIndex = hasStageEnvPreset(ctx.state.stage, ["focusPointGroups"], requestedIndex) ? requestedIndex : 0;
      const applyLight = () => {
        if (!ctx.QualityConfig.isUnityLightingEnabled()) return;
        ctx.SceneRoot.applyStageLight(requestedIndex);
        ctx.state.stageEnv.light = requestedIndex;
      };
      const applyEffect = () => {
        if (!ctx.QualityConfig.isStageParticleEffectEnabled()) return;
        ctx.SceneRoot.changeStageParticleEffects(requestedIndex);
        ctx.state.stageEnv.effect = requestedIndex;
      };
      const applyPostEffect = () => {
        if (!ctx.QualityConfig.isStagePostEffectEnabled()) return;
        ctx.SceneRoot.applyStagePostEffect(requestedIndex);
        ctx.state.stageEnv.postEffect = requestedIndex;
      };
      const applyFocusPosition = () => {
        ctx.SceneRoot.applyStageEnv(focusIndex);
        ctx.state.stageEnv.focusPosition = focusIndex;
      };

      switch (envType) {
        case ADV_STAGE_ENV_TYPE.All:
          applyLight();
          applyEffect();
          applyPostEffect();
          applyFocusPosition();
          ctx.SceneRoot.sortCharacters();
          ctx.state.stageEnv.all = requestedIndex;
          break;
        case ADV_STAGE_ENV_TYPE.Light:
          applyLight();
          break;
        case ADV_STAGE_ENV_TYPE.Effect:
          applyEffect();
          break;
        case ADV_STAGE_ENV_TYPE.PostEffect:
          applyPostEffect();
          break;
        case ADV_STAGE_ENV_TYPE.FocusPosition:
          applyFocusPosition();
          break;
        default:
          // Enum.TryParse accepts undefined numeric enum values; native logs and performs no mutation.
          console.warn("[story] Unsupported stage environment type", envType);
      }
    });

    register(ADV_COMMAND.RimLight, async (cmd, ctx) => {
      await this.runCommandTask(cmd, () =>
        Promise.all(
          targetKeys(cmd).map((target: string) =>
            ctx.SceneRoot.setRimLight(target, param(cmd, 0), finite(param(cmd, 1), 0)),
          ),
        ),
      );
    });

    register(ADV_COMMAND.Role, (cmd, ctx, signal) => {
      return this.runTransitionCommandTask(
        cmd,
        "role",
        (transitionSignal) =>
          ctx.SceneRoot.setCameraRoll(
            finite(param(cmd, 0), 0),
            commandDuration(ctx, cmd, 0),
            param(cmd, 1) || 6,
            transitionSignal,
          ),
        signal || this.abortController.signal,
      );
    });

    register(ADV_COMMAND.Timeline, async (cmd, ctx, signal) => {
      await this.PlayableDirector.execute(cmd, ctx.Model.shouldShortCut, signal);
    });
  }
}
