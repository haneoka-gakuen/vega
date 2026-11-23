export interface VegaStageAdjustment {
  target: string;
  durationSeconds: number;
  mode: "adjustment" | "mask";
  shape: "full" | "rectangle" | "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
  feather: number;
  invert: boolean;
  exposure: number;
  contrast: number;
  saturation: number;
  opacity: number;
  rotationDegrees: number;
  cornerRadius: number;
  maskSource?: string;
  maskChannel?: "alpha" | "luma";
}

export function parseVegaStageAdjustment(value: Readonly<Record<string, unknown>>): VegaStageAdjustment {
  const number = (field: keyof VegaStageAdjustment, lower: number, upper: number, fallback: number): number => {
    const selected = value[field] ?? fallback;
    if (typeof selected !== "number" || !Number.isFinite(selected) || selected < lower || selected > upper)
      throw new TypeError(`Invalid adjustment field ${field}`);
    return selected;
  };
  const { target, mode = "adjustment", shape = "full", invert = false } = value;
  const maskSource = value.maskSource ?? value.source;
  const maskChannel = value.maskChannel ?? "alpha";
  if (typeof target !== "string" || !target.trim()) throw new TypeError("An adjustment target is required");
  if (mode !== "adjustment" && mode !== "mask") throw new TypeError("Invalid adjustment mode");
  if (shape !== "full" && shape !== "rectangle" && shape !== "ellipse") throw new TypeError("Invalid mask shape");
  if (typeof invert !== "boolean") throw new TypeError("Invalid mask inversion");
  if (maskSource !== undefined && typeof maskSource !== "string") throw new TypeError("Invalid mask image");
  if (maskChannel !== "alpha" && maskChannel !== "luma") throw new TypeError("Invalid mask channel");
  return {
    target: target.trim(),
    durationSeconds: number("durationSeconds", 0.001, Number.MAX_SAFE_INTEGER, 2),
    mode,
    shape,
    x: number("x", 0, 1, 0.5),
    y: number("y", 0, 1, 0.5),
    width: number("width", 0.001, 1, 1),
    height: number("height", 0.001, 1, 1),
    feather: number("feather", 0, 1, 0),
    invert,
    exposure: number("exposure", -4, 4, 0),
    contrast: number("contrast", 0, 3, 1),
    saturation: number("saturation", 0, 3, 1),
    opacity: number("opacity", 0, 1, 1),
    rotationDegrees: number("rotationDegrees", -360, 360, 0),
    cornerRadius: number("cornerRadius", 0, 1, 0),
    ...(typeof maskSource === "string" && maskSource.trim() ? { maskSource: maskSource.trim(), maskChannel } : {}),
  };
}
