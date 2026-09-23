import type { VegaAsset, VegaLocalizedText, VegaProjectLanguage, VegaProjectLocalization } from "./model.js";

export const VEGA_PROJECT_LOCALIZATION_METADATA_KEY = "vega:localization" as const;
export const VEGA_PROJECT_LOCALIZATION_VERSION = 1 as const;

const LOCALIZATION_KEYS = new Set(["version", "languages", "defaultLanguage", "fallbackLanguage"]);
const LANGUAGE_KEYS = new Set(["tag", "label", "fontAssets"]);
const GRANDFATHERED_LANGUAGE_TAGS = new Set([
  "art-lojban",
  "cel-gaulish",
  "en-gb-oed",
  "i-ami",
  "i-bnn",
  "i-default",
  "i-enochian",
  "i-hak",
  "i-klingon",
  "i-lux",
  "i-mingo",
  "i-navajo",
  "i-pwn",
  "i-tao",
  "i-tay",
  "i-tsu",
  "no-bok",
  "no-nyn",
  "sgn-be-fr",
  "sgn-be-nl",
  "sgn-ch-de",
  "zh-guoyu",
  "zh-hakka",
  "zh-min",
  "zh-min-nan",
  "zh-xiang",
]);

export interface VegaLanguageResolutionOptions {
  /**
   * A BCP 47 tag, or `auto` to use `preferredLanguages`.
   * An omitted value has the same behavior as `auto`.
   */
  readonly requested?: string;
  /** Host language preferences, ordered from most to least preferred. */
  readonly preferredLanguages?: readonly string[];
}

export interface VegaResolvedLocalizedText {
  readonly text: string;
  /** The canonical tag that supplied `text`; absent for scalar or missing text. */
  readonly language?: string;
}

export class VegaLocalizationParseError extends TypeError {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = "VegaLocalizationParseError";
    this.path = path;
    this.reason = reason;
  }
}

/**
 * Canonicalizes a structurally valid BCP 47 language tag.
 */
export const canonicalizeVegaLanguageTag = (tag: string): string => canonicalizeLanguageTagAt(tag, "$");

/**
 * Parses and canonicalizes versioned project-localization metadata.
 *
 * When `assets` is supplied, every `fontAssets` entry is also checked against
 * the project asset table. Project parsing always supplies this table.
 */
export const parseVegaProjectLocalization = (
  input: unknown,
  assets?: Readonly<Record<string, VegaAsset>>,
): VegaProjectLocalization => {
  const localization = requireRecord(input, "$");
  rejectUnknownKeys(localization, LOCALIZATION_KEYS, "$");

  if (localization.version !== VEGA_PROJECT_LOCALIZATION_VERSION) {
    fail("$.version", `expected version ${VEGA_PROJECT_LOCALIZATION_VERSION}`);
  }
  const languageValues = localization.languages;
  if (!Array.isArray(languageValues) || languageValues.length === 0) {
    fail("$.languages", "expected a non-empty array");
  }

  const canonicalTags = new Set<string>();
  const languages = languageValues.map((value, index) => {
    const path = `$.languages[${index}]`;
    const language = requireRecord(value, path);
    rejectUnknownKeys(language, LANGUAGE_KEYS, path);
    const tag = canonicalizeLanguageTagAt(language.tag, `${path}.tag`);
    const identity = tag.toLowerCase();
    if (canonicalTags.has(identity)) {
      fail(`${path}.tag`, `duplicate canonical language tag ${JSON.stringify(tag)}`);
    }
    canonicalTags.add(identity);

    const parsed: {
      tag: string;
      label?: VegaLocalizedText;
      fontAssets?: string[];
    } = { tag };
    if (language.label !== undefined) {
      parsed.label = parseLocalizedText(language.label, `${path}.label`);
    }
    if (language.fontAssets !== undefined) {
      parsed.fontAssets = parseFontAssets(language.fontAssets, `${path}.fontAssets`, assets);
    }
    return parsed;
  });

  const defaultLanguage = canonicalizeLanguageTagAt(localization.defaultLanguage, "$.defaultLanguage");
  assertDeclaredLanguage(defaultLanguage, canonicalTags, "$.defaultLanguage");

  let fallbackLanguage: string | undefined;
  if (localization.fallbackLanguage !== undefined) {
    fallbackLanguage = canonicalizeLanguageTagAt(localization.fallbackLanguage, "$.fallbackLanguage");
    assertDeclaredLanguage(fallbackLanguage, canonicalTags, "$.fallbackLanguage");
  }

  return {
    version: VEGA_PROJECT_LOCALIZATION_VERSION,
    languages,
    defaultLanguage,
    ...(fallbackLanguage === undefined ? {} : { fallbackLanguage }),
  };
};

/**
 * Parses localized text and canonicalizes all language-map keys.
 */
export const parseVegaLocalizedText = (input: unknown): VegaLocalizedText => parseLocalizedText(input, "$");

/**
 * Resolves one declared language using RFC 4647-style lookup, followed by the
 * configured fallback and default languages.
 */
export const resolveVegaLanguageTag = (
  localization: VegaProjectLocalization,
  options: VegaLanguageResolutionOptions = {},
): string => {
  const parsed = parseVegaProjectLocalization(localization);
  return resolveParsedLanguageTag(parsed, options);
};

/**
 * Resolves the full language declaration, including its font asset priority.
 */
export const resolveVegaProjectLanguage = (
  localization: VegaProjectLocalization,
  options: VegaLanguageResolutionOptions = {},
): VegaProjectLanguage => {
  const parsed = parseVegaProjectLocalization(localization);
  const tag = resolveParsedLanguageTag(parsed, options);
  return parsed.languages.find((language) => language.tag === tag)!;
};

/**
 * Resolves localized text without falling back to an arbitrary object entry.
 */
export const resolveVegaLocalizedText = (
  value: VegaLocalizedText,
  localization: VegaProjectLocalization,
  options: VegaLanguageResolutionOptions = {},
): VegaResolvedLocalizedText => {
  if (typeof value === "string") return { text: value };

  const parsed = parseVegaProjectLocalization(localization);
  const localized = parseLocalizedText(value, "$");
  if (typeof localized === "string") return { text: localized };

  const selected = resolveParsedLanguageTag(parsed, options);
  const candidates = unique([selected, parsed.fallbackLanguage, parsed.defaultLanguage]);
  for (const candidate of candidates) {
    const match = lookupLocalizedText(localized, candidate);
    if (match) return match;
  }
  return { text: "" };
};

const resolveParsedLanguageTag = (
  localization: VegaProjectLocalization,
  options: VegaLanguageResolutionOptions,
): string => {
  const available = new Map(localization.languages.map((language) => [language.tag.toLowerCase(), language.tag]));
  const requested =
    options.requested === undefined || options.requested === "auto"
      ? (options.preferredLanguages ?? [])
      : [options.requested];

  if (requested.length === 0) return localization.defaultLanguage;
  for (const preference of requested) {
    const canonical = tryCanonicalizeLanguageTag(preference);
    if (!canonical) continue;
    const match = lookupAvailableLanguage(available, canonical);
    if (match) return match;
  }
  return localization.fallbackLanguage ?? localization.defaultLanguage;
};

const lookupAvailableLanguage = (available: ReadonlyMap<string, string>, requested: string): string | undefined => {
  let candidate = requested;
  while (candidate) {
    const match = available.get(candidate.toLowerCase());
    if (match) return match;
    candidate = truncateLanguageRange(candidate);
  }
  return undefined;
};

const lookupLocalizedText = (
  localized: Readonly<Record<string, string>>,
  requested: string,
): VegaResolvedLocalizedText | undefined => {
  let candidate = requested;
  while (candidate) {
    if (Object.hasOwn(localized, candidate)) {
      return { text: localized[candidate]!, language: candidate };
    }
    candidate = truncateLanguageRange(candidate);
  }
  return undefined;
};

const truncateLanguageRange = (tag: string): string => {
  const subtags = tag.split("-");
  subtags.pop();
  while (subtags.length > 0 && subtags[subtags.length - 1]!.length === 1) {
    subtags.pop();
  }
  return subtags.join("-");
};

const parseLocalizedText = (value: unknown, path: string): VegaLocalizedText => {
  if (typeof value === "string") return value;
  const localized = requireRecord(value, path);
  if (Object.keys(localized).length === 0) {
    fail(path, "localized text cannot be empty");
  }

  const parsed: Record<string, string> = {};
  const canonicalTags = new Set<string>();
  for (const [rawTag, text] of Object.entries(localized)) {
    const tag = canonicalizeLanguageTagAt(rawTag, `${path}.${rawTag}`);
    const identity = tag.toLowerCase();
    if (canonicalTags.has(identity)) {
      fail(`${path}.${rawTag}`, `duplicate canonical language tag ${JSON.stringify(tag)}`);
    }
    const parsedText = requireString(text, `${path}.${rawTag}`);
    canonicalTags.add(identity);
    parsed[tag] = parsedText;
  }
  return parsed;
};

const parseFontAssets = (value: unknown, path: string, assets?: Readonly<Record<string, VegaAsset>>): string[] => {
  const assetIds = value;
  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    fail(path, "expected a non-empty array");
  }
  const parsed: string[] = [];
  const seen = new Set<string>();
  assetIds.forEach((value, index) => {
    const assetPath = `${path}[${index}]`;
    const assetId = requireNonEmptyString(value, assetPath);
    if (seen.has(assetId)) fail(assetPath, "duplicate font asset id");
    seen.add(assetId);
    if (assets !== undefined) {
      const asset = assets[assetId];
      if (!asset) fail(assetPath, `font asset ${JSON.stringify(assetId)} does not exist`);
      if (asset.type !== "font") {
        fail(assetPath, `asset ${JSON.stringify(assetId)} is not a font`);
      }
    }
    parsed.push(assetId);
  });
  return parsed;
};

const assertDeclaredLanguage = (tag: string, canonicalTags: ReadonlySet<string>, path: string): void => {
  if (!canonicalTags.has(tag.toLowerCase())) {
    fail(path, `language ${JSON.stringify(tag)} is not declared`);
  }
};

const canonicalizeLanguageTagAt = (value: unknown, path: string): string => {
  const tag = requireNonEmptyString(value, path).trim().replace(/_/gu, "-");
  const lower = tag.toLowerCase();
  if (GRANDFATHERED_LANGUAGE_TAGS.has(lower) || /^x(?:-[a-z0-9]{1,8})+$/u.test(lower)) {
    return lower;
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(tag);
    if (!canonical) fail(path, "expected a valid BCP 47 language tag");
    return canonical;
  } catch {
    return fail(path, "expected a valid BCP 47 language tag");
  }
};

const tryCanonicalizeLanguageTag = (value: unknown): string | undefined => {
  try {
    return canonicalizeLanguageTagAt(value, "$");
  } catch {
    return undefined;
  }
};

const unique = (values: readonly (string | undefined)[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value === undefined || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
};

const requireRecord = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "expected a plain object");
  }
  return value as Record<string, unknown>;
};

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected a string");
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(path, "expected a non-empty string");
  }
  return value;
}

const rejectUnknownKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
  }
};

function fail(path: string, reason: string): never {
  throw new VegaLocalizationParseError(path, reason);
}
