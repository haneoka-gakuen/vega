/** Release-bound original UI records; original 64-bit identities remain strings. */
export interface StoryStillExternalLayoutSource {
  readonly schema: "haneoka-still-external-layout-v1";
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly serializedFile: string;
  readonly recordsSHA256: string;
  readonly canvasRectId: string;
  readonly scalerId: string;
  readonly viewComponentId: string;
  readonly records: readonly Readonly<Record<string, unknown>>[];
}
type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];
type Quaternion = readonly [number, number, number, number];
type Affine = readonly [number, number, number, number, number, number];
export interface StoryStillExternalNode {
  readonly id: string;
  readonly parentId: string;
  readonly active: boolean;
  readonly alpha: number;
  readonly hasCanvasGroup: boolean;
  readonly anchorMin: Vec2;
  readonly anchorMax: Vec2;
  readonly anchoredPosition: Vec2;
  readonly sizeDelta: Vec2;
  readonly pivot: Vec2;
  readonly scale: Vec3;
  readonly rotation: Quaternion;
  readonly localZ: number;
}
export interface StoryStillExternalContract {
  readonly source: StoryStillExternalLayoutSource;
  readonly targetId: string;
  readonly nodes: readonly StoryStillExternalNode[];
  readonly referenceResolution: Vec2;
  readonly matchWidthOrHeight: number;
  readonly screenMatchMode: 0 | 1 | 2;
  readonly maxAspectThreshold: number;
  readonly canvas: Readonly<Record<string, unknown>>;
}
export interface StoryStillExternalPlacement {
  readonly id: string;
  readonly parentId: string;
  /** Local bottom-up rect: x, y, width, height. */
  readonly rect: readonly [number, number, number, number];
  readonly pivot: Vec2;
  readonly transform: Affine;
  /** Column-major matrix in bottom-left canvas coordinates. */
  readonly transform3D: readonly number[];
  readonly active: boolean;
  readonly opacity: number;
  readonly planar: boolean;
  readonly containedScale: number;
}
export interface StoryStillExternalLayout {
  readonly source: StoryStillExternalLayoutSource;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly canvasScale: number;
  readonly runtimeRoot: StoryStillExternalPlacement;
  readonly nodes: readonly StoryStillExternalPlacement[];
  readonly target: StoryStillExternalPlacement;
}
const object = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid Still external object");
  return value as Readonly<Record<string, unknown>>;
};
const number = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("Invalid Still external number");
  return value;
};
const identity = (value: unknown): string => {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new TypeError("Invalid Still external identity");
  return value;
};
const pointer = (value: unknown): string => {
  const p = object(value);
  if (p.m_FileID !== 0) throw new TypeError("Unsupported Still external object file");
  return identity(p.m_PathID);
};
const vector = (value: unknown, axes: string): number[] => {
  const v = object(value);
  return [...axes].map((axis) => number(v[axis]));
};
const enabled = (value: unknown): boolean => {
  if (value !== 0 && value !== 1 && value !== false && value !== true)
    throw new TypeError("Invalid Still external enabled state");
  return value === 1 || value === true;
};
const contracts = new WeakMap<object, StoryStillExternalContract>();
/** Validate once per release-owned source object, before viewport sampling. */
export function validateStoryStillExternalLayout(value: unknown): StoryStillExternalContract {
  const source = object(value);
  const cached = contracts.get(source);
  if (cached) return cached;
  if (source.schema !== "haneoka-still-external-layout-v1") throw new TypeError("Unsupported Still external schema");
  for (const key of ["sourceId", "sourcePath", "serializedFile"])
    if (typeof source[key] !== "string" || !source[key]) throw new TypeError(`Missing Still external ${key}`);
  for (const key of ["sourceHash", "recordsSHA256"])
    if (typeof source[key] !== "string" || !/^[a-f0-9]{64}$/.test(source[key]))
      throw new TypeError(`Invalid Still external ${key}`);
  const canvasId = identity(source.canvasRectId),
    scalerId = identity(source.scalerId),
    viewId = identity(source.viewComponentId);
  if (!Array.isArray(source.records) || source.records.length > 256)
    throw new TypeError("Invalid Still external records");
  const records = new Map<string, Readonly<Record<string, unknown>>>();
  const checkPointers = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) checkPointers(child);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key === "m_PathID" || key === "pathId") identity(child);
        else checkPointers(child);
      }
    }
  };
  for (const raw of source.records) {
    checkPointers(raw);
    const record = object(raw),
      id = identity(record.pathId);
    if (record.serializedFile !== source.serializedFile || records.has(id))
      throw new TypeError("Invalid Still external record binding");
    records.set(id, record);
  }
  const record = (id: string, type: string): Readonly<Record<string, unknown>> => {
    const r = records.get(id);
    if (!r || r.type !== type) throw new TypeError(`Missing Still external ${type}: ${id}`);
    return object(r.data);
  };
  const script = (data: Readonly<Record<string, unknown>>): string => {
    const p = object(data.m_Script),
      ref = object(p.reference);
    if (
      ref.status !== "resolved" ||
      ref.type !== "MonoScript" ||
      typeof ref.name !== "string" ||
      typeof ref.serializedFile !== "string" ||
      !ref.serializedFile ||
      identity(ref.pathId) !== identity(p.m_PathID) ||
      typeof ref.externalPath !== "string" ||
      !ref.externalPath.endsWith(`/${ref.serializedFile}`) ||
      !Number.isInteger(p.m_FileID) ||
      number(p.m_FileID) <= 0
    )
      throw new TypeError("Invalid Still external script binding");
    return ref.name;
  };
  const componentIds = (game: Readonly<Record<string, unknown>>): string[] => {
    if (!Array.isArray(game.m_Component)) throw new TypeError("Missing Still external components");
    const ids = game.m_Component.map((v) => pointer(object(v).component));
    if (new Set(ids).size !== ids.length) throw new TypeError("Duplicate Still external component");
    return ids;
  };
  const canvasRect = record(canvasId, "RectTransform"),
    canvasObjectId = pointer(canvasRect.m_GameObject);
  const canvasObject = record(canvasObjectId, "GameObject"),
    scaler = record(scalerId, "MonoBehaviour"),
    view = record(viewId, "MonoBehaviour");
  if (
    !enabled(canvasObject.m_IsActive) ||
    !enabled(scaler.m_Enabled) ||
    !enabled(view.m_Enabled) ||
    number(scaler.m_UiScaleMode) !== 1 ||
    script(scaler) !== "ClampedCanvasScaler" ||
    script(view) !== "AdvStillView" ||
    pointer(scaler.m_GameObject) !== canvasObjectId
  )
    throw new TypeError("Invalid Still external view/scaler binding");
  let canvas: Readonly<Record<string, unknown>> | undefined;
  const canvasComponents = componentIds(canvasObject);
  if (!canvasComponents.includes(canvasId) || !canvasComponents.includes(scalerId))
    throw new TypeError("Missing Still external canvas components");
  for (const id of canvasComponents) {
    const component = records.get(id);
    if (!component) throw new TypeError("Missing Still external canvas record");
    const data = object(component.data);
    if (pointer(data.m_GameObject) !== canvasObjectId) throw new TypeError("Invalid Still external canvas owner");
    if (id === canvasId || id === scalerId) continue;
    if (component.type === "Canvas" && !canvas) canvas = data;
    else if (component.type !== "MonoBehaviour" || script(data) !== "GraphicRaycaster" || enabled(data.m_Enabled))
      throw new TypeError("Unsupported Still external canvas component");
  }
  if (
    !canvas ||
    !enabled(canvas.m_Enabled) ||
    number(canvas.m_RenderMode) !== 1 ||
    canvas.m_OverrideSorting !== false ||
    canvas.m_PixelPerfect !== false ||
    canvas.m_OverridePixelPerfect !== false ||
    !Number.isInteger(canvas.m_SortingOrder) ||
    pointer(canvas.m_Camera) === "0" ||
    number(canvas.m_PlaneDistance) <= 0 ||
    number(scaler.m_ReferencePixelsPerUnit) <= 0
  )
    throw new TypeError("Unsupported Still external canvas contract");
  const targetId = pointer(view._target),
    reverse: StoryStillExternalNode[] = [],
    seen = new Set<string>();
  let id = targetId;
  while (id !== canvasId) {
    if (seen.has(id)) throw new TypeError("Cyclic Still external parent");
    seen.add(id);
    const rect = record(id, "RectTransform"),
      gameId = pointer(rect.m_GameObject),
      game = record(gameId, "GameObject");
    const ids = componentIds(game);
    if (!ids.includes(id)) throw new TypeError("Missing Still external transform binding");
    let alpha = 1,
      group = false;
    for (const componentId of ids) {
      const component = records.get(componentId);
      if (!component) throw new TypeError("Missing Still external component record");
      const data = object(component.data);
      if (pointer(data.m_GameObject) !== gameId) throw new TypeError("Invalid Still external component owner");
      if (componentId === id) continue;
      if (component.type === "CanvasGroup") {
        if (enabled(data.m_Enabled)) {
          if (group || data.m_IgnoreParentGroups !== false)
            throw new TypeError("Unsupported Still external CanvasGroup");
          group = true;
          alpha = number(data.m_Alpha);
        }
      } else if (componentId !== viewId || component.type !== "MonoBehaviour" || script(data) !== "AdvStillView")
        throw new TypeError("Unsupported Still external layout component");
    }
    reverse.push({
      id,
      parentId: pointer(rect.m_Father),
      active: enabled(game.m_IsActive),
      alpha,
      hasCanvasGroup: group,
      anchorMin: vector(rect.m_AnchorMin, "xy") as unknown as Vec2,
      anchorMax: vector(rect.m_AnchorMax, "xy") as unknown as Vec2,
      anchoredPosition: vector(rect.m_AnchoredPosition, "xy") as unknown as Vec2,
      sizeDelta: vector(rect.m_SizeDelta, "xy") as unknown as Vec2,
      pivot: vector(rect.m_Pivot, "xy") as unknown as Vec2,
      scale: vector(rect.m_LocalScale, "xyz") as unknown as Vec3,
      rotation: vector(rect.m_LocalRotation, "xyzw") as unknown as Quaternion,
      localZ: number(object(rect.m_LocalPosition).z),
    });
    id = reverse.at(-1)!.parentId;
  }
  if (
    reverse.length < 2 ||
    pointer(record(reverse[1]!.id, "RectTransform").m_GameObject) !== pointer(view.m_GameObject) ||
    !componentIds(record(pointer(view.m_GameObject), "GameObject")).includes(viewId)
  )
    throw new TypeError("Invalid Still external target parent");
  const referenceResolution = vector(scaler.m_ReferenceResolution, "xy") as unknown as Vec2;
  const mode = number(scaler.m_ScreenMatchMode),
    threshold = number(scaler._maxAspectThreshold);
  if (!referenceResolution.every((v) => v > 0) || threshold <= 0 || ![0, 1, 2].includes(mode))
    throw new TypeError("Unsupported Still external scaler");
  const result: StoryStillExternalContract = {
    source: source as unknown as StoryStillExternalLayoutSource,
    targetId,
    nodes: reverse.reverse(),
    referenceResolution,
    screenMatchMode: mode as 0 | 1 | 2,
    matchWidthOrHeight: number(scaler.m_MatchWidthOrHeight),
    maxAspectThreshold: threshold,
    canvas,
  };
  contracts.set(source, result);
  return result;
}
const affineProduct = (a: Affine, b: Affine): Affine => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const matrixProduct = (a: readonly number[], b: readonly number[]): number[] => {
  const result = new Array<number>(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      result[c * 4 + r] =
        a[r]! * b[c * 4]! + a[r + 4]! * b[c * 4 + 1]! + a[r + 8]! * b[c * 4 + 2]! + a[r + 12]! * b[c * 4 + 3]!;
  return result;
};
/** Pure geometry. Attachment and live tween state are supplied by the consumer separately. */
export function resolveStoryStillExternalLayout(
  contract: StoryStillExternalContract,
  width: number,
  height: number,
): StoryStillExternalLayout {
  if (![width, height].every((v) => Number.isFinite(v) && v > 0))
    throw new TypeError("Invalid Still external viewport");
  const rx = width / contract.referenceResolution[0],
    ry = height / contract.referenceResolution[1];
  const match = Math.max(0, Math.min(1, contract.matchWidthOrHeight)),
    aspect = width / height;
  let scale =
    contract.screenMatchMode === 0
      ? 2 ** ((1 - match) * Math.log2(rx) + match * Math.log2(ry))
      : contract.screenMatchMode === 1
        ? Math.min(rx, ry)
        : Math.max(rx, ry);
  if (aspect > contract.maxAspectThreshold) scale = contract.maxAspectThreshold / aspect;
  const W = width / scale,
    H = height / scale,
    F = Math.fround;
  const root: StoryStillExternalPlacement = {
    id: contract.source.canvasRectId,
    parentId: "",
    rect: [F(-W / 2), F(-H / 2), F(W), F(H)],
    pivot: [0.5, 0.5],
    transform: [1, 0, 0, 1, W / 2, H / 2],
    transform3D: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, W / 2, H / 2, 0, 1],
    active: true,
    opacity: 1,
    planar: true,
    containedScale: 1,
  };
  let parent = root;
  const nodes: StoryStillExternalPlacement[] = [];
  for (const node of contract.nodes) {
    if (node.parentId !== parent.id) throw new TypeError("Invalid Still external chain order");
    const [px, py, pw, ph] = parent.rect;
    const minX = F(px + F(node.anchorMin[0] * pw)),
      maxX = F(px + F(node.anchorMax[0] * pw));
    const minY = F(py + F(node.anchorMin[1] * ph)),
      maxY = F(py + F(node.anchorMax[1] * ph));
    const w = F(F(maxX - minX) + node.sizeDelta[0]),
      h = F(F(maxY - minY) + node.sizeDelta[1]);
    const tx = F(F(minX + F(F(maxX - minX) * node.pivot[0])) + node.anchoredPosition[0]);
    const ty = F(F(minY + F(F(maxY - minY) * node.pivot[1])) + node.anchoredPosition[1]);
    const contained = node.id === contract.targetId && pw > 0 && ph > 0 ? F(Math.min(F(pw / 1920), F(ph / 1080))) : 1;
    const [sx, sy, sz] = node.id === contract.targetId && pw > 0 && ph > 0 ? [contained, contained, 1] : node.scale;
    const [x, y, z, qw] = node.rotation,
      x2 = F(x * 2),
      y2 = F(y * 2),
      z2 = F(z * 2);
    const xx = F(x * x2),
      yy = F(y * y2),
      zz = F(z * z2),
      xy = F(x * y2),
      wz = F(qw * z2);
    const affine: Affine = [
      F(F(1 - F(yy + zz)) * sx!),
      F(F(xy + wz) * sx!),
      F(F(xy - wz) * sy!),
      F(F(1 - F(xx + zz)) * sy!),
      tx,
      ty,
    ];
    const local = [
      (1 - 2 * (y * y + z * z)) * sx!,
      2 * (x * y + qw * z) * sx!,
      2 * (x * z - qw * y) * sx!,
      0,
      2 * (x * y - qw * z) * sy!,
      (1 - 2 * (x * x + z * z)) * sy!,
      2 * (y * z + qw * x) * sy!,
      0,
      2 * (x * z + qw * y) * sz!,
      2 * (y * z - qw * x) * sz!,
      (1 - 2 * (x * x + y * y)) * sz!,
      0,
      tx,
      ty,
      node.localZ,
      1,
    ];
    const placement: StoryStillExternalPlacement = {
      id: node.id,
      parentId: node.parentId,
      rect: [F(-node.pivot[0] * w), F(-node.pivot[1] * h), w, h],
      pivot: node.pivot,
      transform: affineProduct(parent.transform, affine),
      transform3D: matrixProduct(parent.transform3D, local),
      active: parent.active && node.active,
      opacity: node.hasCanvasGroup ? F(parent.opacity * node.alpha) : parent.opacity,
      planar: parent.planar && node.localZ === 0 && Math.abs(x) <= 1e-7 && Math.abs(y) <= 1e-7,
      containedScale: contained,
    };
    nodes.push(placement);
    parent = placement;
  }
  return {
    source: contract.source,
    physicalWidth: width,
    physicalHeight: height,
    logicalWidth: W,
    logicalHeight: H,
    canvasScale: scale,
    runtimeRoot: root,
    nodes,
    target: parent,
  };
}
