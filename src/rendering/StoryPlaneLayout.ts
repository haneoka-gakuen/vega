export interface StoryPlaneLayout {
  readonly anchor?: "camera" | "stage";
  readonly referenceWidth?: number;
  readonly referenceHeight?: number;
  readonly fit?: "contain" | "cover" | "height" | "width";
  readonly scale?: number;
  readonly align?: readonly [number, number];
  readonly offset?: readonly [number, number];
  readonly centerOverflow?: boolean;
  /** Top, right, bottom, left padding in source-image pixels. */
  readonly padding?: readonly [number, number, number, number];
  readonly positions?: Readonly<Record<string, StoryPlaneLayout>>;
}
export interface StoryPlaneFit {
  readonly referenceWidth: number;
  readonly referenceHeight: number;
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}
const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export function resolveStoryPlaneLayout(layout: StoryPlaneLayout, width: number, height: number): StoryPlaneFit {
  const referenceWidth = Math.max(1, finite(layout.referenceWidth, 2560)),
    referenceHeight = Math.max(1, finite(layout.referenceHeight, 1440));
  const horizontal = referenceWidth / Math.max(0.000001, width),
    vertical = referenceHeight / Math.max(0.000001, height);
  const factor =
    layout.fit === "height"
      ? vertical
      : layout.fit === "width"
        ? horizontal
        : layout.fit === "cover"
          ? Math.max(horizontal, vertical)
          : Math.min(horizontal, vertical);
  const scale = factor * Math.max(0, finite(layout.scale, 1));
  let gapX = referenceWidth - width * scale,
    gapY = referenceHeight - height * scale;
  if (layout.centerOverflow) {
    gapX = Math.max(0, gapX);
    gapY = Math.max(0, gapY);
  }
  return {
    referenceWidth,
    referenceHeight,
    scale,
    x: referenceWidth / 2 + gapX * (finite(layout.align?.[0], 0.5) - 0.5) + finite(layout.offset?.[0], 0),
    y: referenceHeight / 2 + gapY * (finite(layout.align?.[1], 0.5) - 0.5) + finite(layout.offset?.[1], 0),
  };
}
