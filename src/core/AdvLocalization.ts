import type { StoryResolvedText } from "../runtime";

export const canonicalAdvLocale = (value: string) => {
  try {
    return Intl.getCanonicalLocales(value.replaceAll("_", "-"))[0]!.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
};

export function resolveAdvLocale(
  value: unknown,
  locale: string,
  fallback: (value: unknown) => StoryResolvedText,
  arrayOrder: readonly string[] = [],
): StoryResolvedText {
  if (!locale || locale === "auto") return fallback(value);
  const wanted = canonicalAdvLocale(locale);
  const match = (tag: string) => canonicalAdvLocale(tag) === wanted;
  const read = (source: unknown): StoryResolvedText | undefined => {
    if (typeof source === "string" || typeof source === "number") return { text: String(source), lang: locale };
    if (Array.isArray(source)) {
      const exact = arrayOrder.findIndex(match);
      const at = exact >= 0 ? exact : arrayOrder.findIndex((tag) => canonicalAdvLocale(tag) === wanted.split("-")[0]);
      return at < 0 || source[at] == null ? undefined : read(source[at]);
    }
    if (!source || typeof source !== "object") return undefined;
    const record = source as Record<string, unknown>;
    const keys = Object.keys(record);
    const key = keys.find(match) ?? keys.find((key) => canonicalAdvLocale(key) === wanted.split("-")[0]);
    if (key !== undefined) return read(record[key]);
    for (const wrapper of ["values", "text", "value"]) if (record[wrapper] != null) return read(record[wrapper]);
    return undefined;
  };
  return read(value) ?? fallback(value);
}
