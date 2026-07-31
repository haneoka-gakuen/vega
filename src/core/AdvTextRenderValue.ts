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
export const createAdvTextRenderValue = (
  source: unknown,
  metadata: AdvTextRenderMetadata = {},
): AdvTextRenderValue =>
  Object.freeze({
    format:
      typeof metadata.format === "string" && metadata.format.trim()
        ? metadata.format.trim()
        : "adv",
    source: typeof source === "string" ? source : String(source ?? ""),
    ...(metadata.displayMode === undefined
      ? {}
      : { displayMode: metadata.displayMode }),
    ...(metadata.language === undefined
      ? {}
      : { language: metadata.language }),
  });

/** Readable inert fallback for hosts that have no rich-text renderer. */
export const advTextRenderSource = (value: unknown): string => {
  if (
    value &&
    typeof value === "object" &&
    "source" in value &&
    typeof value.source === "string"
  ) {
    return value.source;
  }
  return typeof value === "string" ? value : String(value ?? "");
};
