export const MEDIA_BLEND_MODES = ["normal", "add", "multiply", "screen", "overlay"] as const;
export const MEDIA_MASK_SHAPES = [
  "rectangle",
  "ellipse",
  "half-plane",
  "band",
  "triangle",
  "star",
  "heart",
  "polygon",
] as const;
export type MediaBlendMode = (typeof MEDIA_BLEND_MODES)[number];
export type VegaMediaMask = {
  shape: (typeof MEDIA_MASK_SHAPES)[number];
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotationDegrees: number;
  radius: number;
  feather: number;
  invert: boolean;
  points?: [number, number][];
  strokePixels: number;
  strokeColor: string;
  strokeOnly: boolean;
};
export type VegaMediaGrade = {
  strength?: number;
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  colorFilter?: number[];
  lift?: number[];
  gamma?: number[];
  gain?: number[];
  shadows?: number[];
  midtones?: number[];
  highlights?: number[];
  splitShadows?: number[];
  splitHighlights?: number[];
  splitBalance?: number;
};
export type VegaMediaRasterFilter =
  | { kind: "pixelate"; blockHeight: number; strength: number }
  | { kind: "posterize"; levels: number; strength: number }
  | { kind: "scanlines"; lineHeight: number; darkness: number; strength: number };
export interface VegaMediaEffects {
  mask?: VegaMediaMask;
  blendMode?: MediaBlendMode;
  colorGrade?: VegaMediaGrade;
  rasterFilters?: VegaMediaRasterFilter[];
}
const object = (v: unknown) => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new TypeError("Invalid media effects");
  return v as Record<string, unknown>;
};
const number = (o: Record<string, unknown>, key: string, def: number, min: number, max: number) => {
  const value = o[key] ?? def;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new TypeError("Invalid media effect value");
  return value;
};
export function parseStageMediaEffects(input: Readonly<Record<string, unknown>>): VegaMediaEffects {
  const effects: VegaMediaEffects = {};
  if (input.blendMode !== undefined) {
    if (!MEDIA_BLEND_MODES.includes(input.blendMode as MediaBlendMode)) throw new TypeError("Invalid media blend mode");
    if (input.blendMode !== "normal") effects.blendMode = input.blendMode as MediaBlendMode;
  }
  if (input.mask != null) {
    const m = object(input.mask),
      shape = m.shape as VegaMediaMask["shape"];
    if (!MEDIA_MASK_SHAPES.includes(shape)) throw new TypeError("Invalid media mask shape");
    const color = m.strokeColor ?? "#ffffff";
    if (typeof color !== "string" || !/^#[a-f\d]{6}$/iu.test(color)) throw new TypeError("Invalid media mask stroke");
    let points: [number, number][] | undefined;
    if (shape === "polygon") {
      if (!Array.isArray(m.points) || m.points.length < 3 || m.points.length > 16)
        throw new TypeError("Invalid media mask polygon");
      points = m.points.map((p) => {
        if (
          !Array.isArray(p) ||
          p.length !== 2 ||
          p.some((v) => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1)
        )
          throw new TypeError("Invalid media mask polygon");
        return [p[0], p[1]];
      });
    }
    effects.mask = {
      shape,
      centerX: number(m, "centerX", 0.5, -2, 3),
      centerY: number(m, "centerY", 0.5, -2, 3),
      width: number(m, "width", 1, 0, 4),
      height: number(m, "height", 1, 0, 4),
      rotationDegrees: number(m, "rotationDegrees", 0, -36000, 36000),
      radius: number(m, "radius", 0, 0, 1),
      feather: number(m, "feather", 0, 0, 1),
      invert: m.invert === true,
      strokePixels: number(m, "strokePixels", 0, 0, 40),
      strokeColor: color,
      strokeOnly: m.strokeOnly === true,
      ...(points ? { points } : {}),
    };
  }
  if (input.colorGrade != null) {
    const g = object(input.colorGrade),
      grade: VegaMediaGrade = {
        exposure: number(g, "exposure", 0, -16, 16),
        contrast: number(g, "contrast", 0, -100, 100),
        saturation: number(g, "saturation", 0, -100, 100),
        temperature: number(g, "temperature", 0, -100, 100),
        tint: number(g, "tint", 0, -100, 100),
      };
    for (const key of [
      "colorFilter",
      "lift",
      "gamma",
      "gain",
      "shadows",
      "midtones",
      "highlights",
      "splitShadows",
      "splitHighlights",
    ] as const) {
      if (g[key] === undefined) continue;
      const a = g[key];
      const length = ["colorFilter", "splitShadows", "splitHighlights"].includes(key) ? 3 : 4;
      if (
        !Array.isArray(a) ||
        a.length !== length ||
        a.some((v) => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 16)
      )
        throw new TypeError("Invalid media grade color");
      grade[key] = a as number[];
    }
    if (g.splitBalance !== undefined) grade.splitBalance = number(g, "splitBalance", 0, -100, 100);
    if (g.strength !== undefined) grade.strength = number(g, "strength", 1, 0, 1);
    if (Object.values(grade).some((value) => (typeof value === "number" ? value !== 0 : Array.isArray(value))))
      effects.colorGrade = grade;
  }
  if (input.rasterFilters !== undefined) {
    if (!Array.isArray(input.rasterFilters)) throw new TypeError("Invalid media raster filters");
    effects.rasterFilters = input.rasterFilters.map((raw): VegaMediaRasterFilter => {
      const f = object(raw),
        strength = number(f, "strength", 1, 0, 1);
      if (f.kind === "pixelate")
        return { kind: f.kind, blockHeight: number(f, "blockHeight", 0.0144, 0.0001, 1), strength };
      if (f.kind === "posterize") return { kind: f.kind, levels: number(f, "levels", 6, 2, 256), strength };
      if (f.kind === "scanlines")
        return {
          kind: f.kind,
          lineHeight: number(f, "lineHeight", 1 / 400, 0.0001, 1),
          darkness: number(f, "darkness", 0.14, 0, 1),
          strength,
        };
      throw new TypeError("Invalid media raster filter");
    });
  }
  return effects;
}
