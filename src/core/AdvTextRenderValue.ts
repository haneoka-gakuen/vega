import { defineVegaService } from "../engine/plugins";

/** Plugin-neutral metadata attached to authored story text. */
export interface AdvTextRenderMetadata {
  /** Explicit renderer format. Legacy ADV markup remains the default. */
  readonly format?: string | undefined;
  /** Block-style rendering hint understood by formats that support it. */
  readonly displayMode?: boolean | undefined;
  /** BCP 47 language hint for the rendered text. */
  readonly language?: string | undefined;
}

/**
 * Structural value passed from Vega presenters to an optional rich-text port.
 *
 * Core does not interpret `format`; individual plugins own those semantics.
 */
export interface AdvTextRenderValue {
  readonly format: string;
  readonly source: string;
  readonly displayMode?: boolean;
  readonly language?: string;
}

/**
 * Builds the same renderer input for every Vega presentation mode.
 *
 * An omitted format means the existing ADV text grammar. This is a stable
 * compatibility default, not content sniffing.
 */
export const createAdvTextRenderValue = (source: unknown, metadata: AdvTextRenderMetadata = {}): AdvTextRenderValue =>
  Object.freeze({
    format: typeof metadata.format === "string" && metadata.format.trim() ? metadata.format.trim() : "adv",
    source: typeof source === "string" ? source : String(source ?? ""),
    ...(metadata.displayMode === undefined ? {} : { displayMode: metadata.displayMode }),
    ...(metadata.language === undefined ? {} : { language: metadata.language }),
  });

/** Readable inert fallback for hosts that have no rich-text renderer. */
export const advTextRenderSource = (value: unknown): string => {
  if (value && typeof value === "object" && "source" in value && typeof value.source === "string") {
    return value.source;
  }
  return typeof value === "string" ? value : String(value ?? "");
};

/**
 * Format-owned text measurements the interpreter needs without knowing any
 * markup grammar: typewriter reveal and auto-advance reading time.
 */
export interface AdvTextMetrics {
  /** Visible units (glyphs) of `source` in `format`. */
  visibleLength(source: string, format: string): number;
  /** Well-formed prefix of `source` revealing `units` visible units. */
  sliceVisible(source: string, units: number, format: string): string;
}

/**
 * Grammar-agnostic fallback: angle-bracket spans are treated as markup that
 * reveals atomically; everything else is one unit per code point.
 */
export const DEFAULT_ADV_TEXT_METRICS: AdvTextMetrics = Object.freeze({
  visibleLength(source: string): number {
    let count = 0;
    for (let index = 0; index < source.length; ) {
      if (source[index] === "<") {
        const end = source.indexOf(">", index);
        if (end < 0) break;
        index = end + 1;
        continue;
      }
      index += (source.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
      count += 1;
    }
    return count;
  },
  sliceVisible(source: string, units: number): string {
    let count = 0;
    let index = 0;
    while (index < source.length) {
      if (source[index] === "<") {
        const end = source.indexOf(">", index);
        if (end < 0) break;
        index = end + 1;
        continue;
      }
      if (count >= units) break;
      index += (source.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
      count += 1;
    }
    return source.slice(0, index);
  },
});

/** Service a text plugin provides so the interpreter can measure its markup. */
export const VEGA_TEXT_METRICS = defineVegaService<AdvTextMetrics>("vega.text-metrics.v1");
