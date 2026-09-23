export interface VegaSemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
  readonly build: readonly string[];
}

type Comparator = (version: VegaSemVer) => boolean;

const SEMVER_PATTERN =
  /^[v=]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const parseVegaSemVer = (value: string): VegaSemVer | null => {
  const match = SEMVER_PATTERN.exec(value.trim());
  if (!match) return null;
  const prerelease = (match[4] ?? "")
    .split(".")
    .filter(Boolean)
    .map((part) => {
      if (/^(0|[1-9]\d*)$/.test(part)) return Number(part);
      return part;
    });
  const build = (match[5] ?? "").split(".").filter(Boolean);
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: Object.freeze(prerelease),
    build: Object.freeze(build),
  });
};

export const compareVegaSemVer = (left: string, right: string): number => {
  const a = parseVegaSemVer(left);
  const b = parseVegaSemVer(right);
  if (!a || !b) {
    throw new TypeError(`Cannot compare invalid semantic versions: ${left}, ${right}`);
  }
  return compareParsed(a, b);
};

export const isValidVegaSemVerRange = (range: string): boolean => compileRange(range) !== null;

export const satisfiesVegaSemVer = (version: string, range: string): boolean => {
  const parsed = parseVegaSemVer(version);
  const compiled = compileRange(range);
  if (!parsed || !compiled) return false;
  return compiled.some(({ comparators, prereleaseCores }) => {
    if (!comparators.every((comparator) => comparator(parsed))) return false;
    if (!parsed.prerelease.length) return true;
    return prereleaseCores.has(coreKey(parsed));
  });
};

interface ComparatorSet {
  readonly comparators: readonly Comparator[];
  readonly prereleaseCores: ReadonlySet<string>;
}

const compileRange = (range: string): readonly ComparatorSet[] | null => {
  const source = range.trim();
  if (!source || source === "*" || /^x$/i.test(source)) {
    return [{ comparators: [], prereleaseCores: new Set() }];
  }
  const alternatives = source.split("||").map((entry) => entry.trim());
  if (alternatives.some((entry) => !entry)) return null;
  const result: ComparatorSet[] = [];
  for (const alternative of alternatives) {
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(alternative);
    const tokens = hyphen
      ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`]
      : alternative.replaceAll(",", " ").split(/\s+/).filter(Boolean);
    const comparators: Comparator[] = [];
    const prereleaseCores = new Set<string>();
    for (const token of tokens) {
      const compiled = compileToken(token);
      if (!compiled) return null;
      comparators.push(...compiled.comparators);
      if (compiled.prereleaseCore) prereleaseCores.add(compiled.prereleaseCore);
    }
    result.push({ comparators, prereleaseCores });
  }
  return result;
};

const compileToken = (token: string): { comparators: readonly Comparator[]; prereleaseCore?: string } | null => {
  if (token === "*" || /^x$/i.test(token)) return { comparators: [] };
  const operatorMatch = /^(<=|>=|<|>|=|\^|~)?(.+)$/.exec(token);
  if (!operatorMatch) return null;
  const operator = operatorMatch[1] ?? "=";
  const value = operatorMatch[2]!;

  const wildcard = parseWildcard(value);
  if (wildcard && (wildcard.major === null || wildcard.minor === null || wildcard.patch === null)) {
    const lower = makeVersion(wildcard.major ?? 0, wildcard.minor ?? 0, 0);
    if ((operator === "~" || operator === "^") && wildcard.major !== null) {
      const upper =
        operator === "~"
          ? wildcard.minor === null
            ? makeVersion(wildcard.major + 1, 0, 0)
            : makeVersion(wildcard.major, wildcard.minor + 1, 0)
          : wildcard.major > 0
            ? makeVersion(wildcard.major + 1, 0, 0)
            : wildcard.minor === null
              ? makeVersion(1, 0, 0)
              : wildcard.minor > 0
                ? makeVersion(0, wildcard.minor + 1, 0)
                : makeVersion(0, 1, 0);
      return { comparators: [gte(lower), lt(upper)] };
    }
    if (operator === ">=") return { comparators: [gte(lower)] };
    if (operator === "<") return { comparators: [lt(lower)] };
    if (operator === ">") {
      const boundary =
        wildcard.major === null
          ? null
          : wildcard.minor === null
            ? makeVersion(wildcard.major + 1, 0, 0)
            : makeVersion(wildcard.major, wildcard.minor + 1, 0);
      return boundary ? { comparators: [gte(boundary)] } : null;
    }
    if (operator === "<=") {
      const boundary =
        wildcard.major === null
          ? null
          : wildcard.minor === null
            ? makeVersion(wildcard.major + 1, 0, 0)
            : makeVersion(wildcard.major, wildcard.minor + 1, 0);
      return boundary ? { comparators: [lt(boundary)] } : null;
    }
    if (operator !== "=") return null;
    if (wildcard.major === null) return { comparators: [] };
    if (wildcard.minor === null) {
      const upper = makeVersion(wildcard.major + 1, 0, 0);
      return { comparators: [gte(lower), lt(upper)] };
    }
    if (wildcard.patch === null) {
      const lowerPatch = makeVersion(wildcard.major, wildcard.minor, 0);
      const upper = makeVersion(wildcard.major, wildcard.minor + 1, 0);
      return { comparators: [gte(lowerPatch), lt(upper)] };
    }
  }

  const parsed = parseVegaSemVer(normalizePartialVersion(value));
  if (!parsed) return null;
  const prereleaseCore = parsed.prerelease.length ? coreKey(parsed) : undefined;
  switch (operator) {
    case "=":
      return { comparators: [(version) => compareParsed(version, parsed) === 0], prereleaseCore };
    case ">":
      return { comparators: [(version) => compareParsed(version, parsed) > 0], prereleaseCore };
    case ">=":
      return { comparators: [gte(parsed)], prereleaseCore };
    case "<":
      return { comparators: [lt(parsed)], prereleaseCore };
    case "<=":
      return { comparators: [(version) => compareParsed(version, parsed) <= 0], prereleaseCore };
    case "~": {
      const upper = makeVersion(parsed.major, parsed.minor + 1, 0);
      return { comparators: [gte(parsed), lt(upper)], prereleaseCore };
    }
    case "^": {
      const upper =
        parsed.major > 0
          ? makeVersion(parsed.major + 1, 0, 0)
          : parsed.minor > 0
            ? makeVersion(0, parsed.minor + 1, 0)
            : makeVersion(0, 0, parsed.patch + 1);
      return { comparators: [gte(parsed), lt(upper)], prereleaseCore };
    }
    default:
      return null;
  }
};

const parseWildcard = (value: string): { major: number | null; minor: number | null; patch: number | null } | null => {
  const parts = value.replace(/^[v=]/, "").split(".");
  if (parts.length > 3) return null;
  const result: Array<number | null> = [];
  for (const part of parts) {
    if (/^(?:x|\*)$/i.test(part)) result.push(null);
    else if (/^(?:0|[1-9]\d*)$/.test(part)) result.push(Number(part));
    else return null;
  }
  while (result.length < 3) result.push(null);
  if (result[0] === null && (result[1] !== null || result[2] !== null)) return null;
  if (result[1] === null && result[2] !== null) return null;
  return {
    major: result[0] ?? null,
    minor: result[1] ?? null,
    patch: result[2] ?? null,
  };
};

const normalizePartialVersion = (value: string): string => {
  if (value.includes("-") || value.includes("+")) return value;
  const parts = value.replace(/^[v=]/, "").split(".");
  if (!parts.every((part) => /^(0|[1-9]\d*)$/.test(part))) return value;
  while (parts.length < 3) parts.push("0");
  return parts.join(".");
};

const makeVersion = (major: number, minor: number, patch: number): VegaSemVer => ({
  major,
  minor,
  patch,
  prerelease: [],
  build: [],
});

const gte =
  (minimum: VegaSemVer): Comparator =>
  (version) =>
    compareParsed(version, minimum) >= 0;
const lt =
  (maximum: VegaSemVer): Comparator =>
  (version) =>
    compareParsed(version, maximum) < 0;

const compareParsed = (left: VegaSemVer, right: VegaSemVer): number => {
  for (const key of ["major", "minor", "patch"] as const) {
    const difference = left[key] - right[key];
    if (difference) return Math.sign(difference);
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return Math.sign(a - b);
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return a < b ? -1 : 1;
  }
  return 0;
};

const coreKey = (version: VegaSemVer): string => `${version.major}.${version.minor}.${version.patch}`;
