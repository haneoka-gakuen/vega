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
/** Reserved for future native semantics; extensions must never claim it. */
export const VEGA_FUTURE_NATIVE_OPCODE_RANGE = Object.freeze({ minimum: 101, maximum: 499 });
export const VEGA_COMMAND_GROUP_OPCODE = 500;
export const VEGA_OFFICIAL_OPCODE_RANGE = Object.freeze({ minimum: 500, maximum: 999 });
export const VEGA_OFFICIAL_EXTENSION_RANGE = Object.freeze({ minimum: 501, maximum: 999 });
/**
 * Reserved for future protocol allocation. Neither official extensions nor
 * third-party plugins may claim these values in protocol version 1.
 */
export const VEGA_FUTURE_RESERVED_OPCODE_RANGE = Object.freeze({ minimum: 1_000, maximum: 9_999 });
export const VEGA_THIRD_PARTY_OPCODE_MINIMUM = 10_000;

/** @deprecated Use `VEGA_OFFICIAL_EXTENSION_RANGE`. */
export const VEGA_BUILTIN_EXTENSION_RANGE = VEGA_OFFICIAL_EXTENSION_RANGE;

const DEFINED_NATIVE_OPCODES = new Set<number>(Object.values(VEGA_ADV_OPCODE));

const isSafeOpcode = (opcode: unknown): opcode is number =>
  typeof opcode === "number" && Number.isSafeInteger(opcode) && opcode >= 0;

export const isVegaNativeOpcode = (opcode: unknown): boolean =>
  isSafeOpcode(opcode) && (DEFINED_NATIVE_OPCODES.has(opcode) || opcode === VEGA_COMMAND_GROUP_OPCODE);

/**
 * Values 0-100 are immutable compatibility territory, including retired and
 * currently unassigned gaps. The predicate deliberately differs from
 * `isVegaNativeOpcode`, which only identifies commands implemented today.
 */
export const isVegaCompatibilityOpcode = (opcode: unknown): boolean =>
  isSafeOpcode(opcode) &&
  opcode >= VEGA_NATIVE_COMPATIBILITY_RANGE.minimum &&
  opcode <= VEGA_NATIVE_COMPATIBILITY_RANGE.maximum;

export const isVegaOfficialOpcode = (opcode: unknown): boolean =>
  isSafeOpcode(opcode) &&
  opcode >= VEGA_OFFICIAL_OPCODE_RANGE.minimum &&
  opcode <= VEGA_OFFICIAL_OPCODE_RANGE.maximum;

export const isVegaFutureNativeOpcode = (opcode: unknown): boolean =>
  isSafeOpcode(opcode) &&
  opcode >= VEGA_FUTURE_NATIVE_OPCODE_RANGE.minimum &&
  opcode <= VEGA_FUTURE_NATIVE_OPCODE_RANGE.maximum;

export const isVegaOfficialExtensionOpcode = (opcode: unknown): boolean =>
  isSafeOpcode(opcode) &&
  opcode >= VEGA_OFFICIAL_EXTENSION_RANGE.minimum &&
  opcode <= VEGA_OFFICIAL_EXTENSION_RANGE.maximum;

export const isVegaFutureReservedOpcode = (opcode: unknown): boolean =>
  isSafeOpcode(opcode) &&
  opcode >= VEGA_FUTURE_RESERVED_OPCODE_RANGE.minimum &&
  opcode <= VEGA_FUTURE_RESERVED_OPCODE_RANGE.maximum;

export const isVegaThirdPartyOpcode = (opcode: unknown): boolean =>
  isSafeOpcode(opcode) && opcode >= VEGA_THIRD_PARTY_OPCODE_MINIMUM;

export const isVegaReservedOpcode = (opcode: unknown): boolean =>
  isVegaCompatibilityOpcode(opcode) ||
  isVegaFutureNativeOpcode(opcode) ||
  isVegaOfficialOpcode(opcode) ||
  isVegaFutureReservedOpcode(opcode);

export const isVegaExtensionOpcode = (opcode: unknown): boolean =>
  isVegaOfficialExtensionOpcode(opcode) || isVegaThirdPartyOpcode(opcode);
