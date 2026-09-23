/**
 * Native ADV opcodes. Values 0-100 are immutable compatibility territory.
 * Gaps are intentional and must not be reassigned.
 */
export const VEGA_ADV_OPCODE = Object.freeze({
  In: 0,
  Out: 1,
  Talk: 2,
  Delay: 3,
  Shake: 4,
  FadeOut: 5,
  FadeIn: 6,
  Focus: 7,
  Forward: 9,
  Back: 10,
  Flash: 11,
  Brightness: 12,
  MoveToRight: 13,
  MoveToLeft: 14,
  Bgm: 15,
  SoundVolume: 16,
  Expression: 17,
  Pause: 18,
  Resume: 19,
  Location: 20,
  Motion: 21,
  Character: 23,
  Costume: 24,
  Stage: 25,
  Movie: 26,
  Clip: 27,
  Subtitles: 28,
  Wait: 29,
  Still: 30,
  Se: 31,
  Angle: 32,
  Pan: 33,
  Tilt: 34,
  TalkWindow: 35,
  ChatWindow: 36,
  ChatTalk: 37,
  ChatStamp: 38,
  ChatRead: 39,
  ChoiceSet: 40,
  ChoiceShow: 41,
  GoTo: 42,
  PostEffect: 43,
  Frame: 44,
  Timeline: 45,
  Look: 46,
  Pedestal: 47,
  Track: 48,
  DoF: 49,
  Role: 50,
  CameraShake: 51,
  Voice: 52,
  Zoom: 53,
  Effect: 54,
  Alpha: 55,
  ForceAuto: 56,
  StageEnv: 57,
  RimLight: 58,
  CancelDelay: 59,
  MoveToUp: 60,
  MoveToDown: 61,
  MoveToForward: 62,
  MoveToBack: 63,
  MoveToDirection: 64,
  ChatTyping: 65,
  LookTarget: 66,
  PanV2: 67,
} as const);

export const VEGA_NATIVE_COMPATIBILITY_RANGE = Object.freeze({ minimum: 0, maximum: 100 });
export const VEGA_COMMAND_GROUP_OPCODE = 101;
export const VEGA_SYSTEM_OPCODE = Object.freeze({
  SetVariable: 102,
  Branch: 103,
  JumpScene: 104,
  CallScene: 105,
  ReturnScene: 106,
  Input: 107,
  Unlock: 108,
  FlowCheckpoint: 109,
  SetSetting: 110,
  End: 111,
  SceneMarker: 112,
  SetDialogueVisibility: 113,
} as const);
export const VEGA_EXTENSION_OPCODE_MINIMUM = 114;
export type VegaSystemOpcode = (typeof VEGA_SYSTEM_OPCODE)[keyof typeof VEGA_SYSTEM_OPCODE];
const DEFINED_NATIVE_OPCODES = new Set<number>(Object.values(VEGA_ADV_OPCODE));
const isSafeOpcode = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const isVegaNativeOpcode = (value: unknown): boolean => isSafeOpcode(value) && DEFINED_NATIVE_OPCODES.has(value);
export const isVegaCompatibilityOpcode = (value: unknown): boolean =>
  isSafeOpcode(value) && value <= VEGA_NATIVE_COMPATIBILITY_RANGE.maximum;
export const isVegaReservedOpcode = (value: unknown): boolean =>
  isSafeOpcode(value) && value < VEGA_EXTENSION_OPCODE_MINIMUM;
export const isVegaExtensionOpcode = (value: unknown): boolean =>
  isSafeOpcode(value) && value >= VEGA_EXTENSION_OPCODE_MINIMUM;

/** Stable plugin command identity; the player assigns its numeric execution slot. */
export function vegaCommandType(plugin: string, name: string, schemaVersion: number): string {
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(plugin) ||
    !name.trim() ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1
  )
    throw new TypeError("Invalid plugin command identity");
  return `${plugin}:${encodeURIComponent(name)}@${schemaVersion}`;
}
export function isVegaCommandType(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^([a-z0-9][a-z0-9._-]*):([^@]+)@([1-9][0-9]*)$/.exec(value);
  if (!match) return false;
  try {
    return vegaCommandType(match[1]!, decodeURIComponent(match[2]!), Number(match[3])) === value;
  } catch {
    return false;
  }
}
