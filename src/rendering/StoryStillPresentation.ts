import { resolveEase } from "../core/easing";
import { createAdvDotweenShakePath, sampleAdvDotweenShake, type AdvDotweenShakePath } from "./neutral/AdvDotweenShake";
import type { AdvStillEntry } from "../types/AdvRuntime";
import type { StoryFrameLayout } from "./StoryFrameLayout";
export * from "./StoryStillExternalLayout";
import type { StoryRendererServiceKey } from "./StoryRendererExtensions";
import { resolveStoryStillExternalLayout, validateStoryStillExternalLayout } from "./StoryStillExternalLayout";

export interface StoryStillTween {
  readonly node: string;
  readonly property:
    | "position"
    | "scale"
    | "size"
    | "rotation"
    | "positionZ"
    | "scaleZ"
    | "rotationEuler"
    | "worldRotationEuler"
    | "opacity"
    | "imageColor";
  readonly at: number;
  readonly duration: number;
  readonly iterations?: number;
  readonly loopMode?: "restart" | "yoyo";
  readonly ease: number;
  readonly value: readonly number[];
  readonly relative?: boolean;
  readonly from?: boolean;
  readonly rotationMode?: "fast" | "beyond360";
  readonly shake?: {
    readonly strength: number;
    readonly vibrato: number;
    readonly randomness: number;
    readonly fadeOut: boolean;
  };
}
export interface StoryStillSequence {
  readonly id: string;
  readonly duration: number;
  readonly loop: boolean;
  readonly tweens: readonly StoryStillTween[];
  readonly unsupportedFeatures?: readonly string[];
  readonly actions?: readonly { readonly at: number; readonly operation: "restart"; readonly sequence: string }[];
  /** Programs whose handles are killed when this program is restarted. */
  readonly killWith?: readonly string[];
}
export interface StoryStillPresentation {
  readonly layout: StoryFrameLayout;
  readonly sequences: readonly StoryStillSequence[];
}
export interface StoryStillPresentationProvider {
  resolve(still: AdvStillEntry): StoryStillPresentation | undefined;
}
export const STORY_STILL_PRESENTATION_PROVIDER: StoryRendererServiceKey<StoryStillPresentationProvider> = Object.freeze(
  { id: "vega.stillPresentations" },
);
export interface StoryStillPose {
  readonly position: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly size?: readonly [number, number];
  readonly rotation: number;
  readonly positionZ?: number;
  readonly scaleZ?: number;
  readonly rotationEuler?: readonly [number, number, number];
  readonly worldRotationEuler?: readonly [number, number, number];
  readonly opacity?: number;
  readonly imageColor?: readonly [number, number, number, number];
}
export interface StoryStillAnimationSnapshot {
  readonly sequence: string | null;
  readonly elapsed: number;
  readonly base: Readonly<Record<string, StoryStillPose>>;
  readonly shakePaths?: Readonly<Record<string, AdvDotweenShakePath>>;
  readonly current?: Readonly<Record<string, StoryStillPose>>;
  readonly captures?: readonly {
    readonly started: boolean;
    readonly start: readonly number[];
    readonly end: readonly number[];
  }[];
  readonly attachment?: { readonly pending: boolean; readonly revision: number };
  readonly programs?: readonly {
    readonly state: StoryStillAnimationSnapshot;
    readonly started: boolean;
    readonly finished: boolean;
  }[];
}
interface Track {
  readonly tween: StoryStillTween;
  start: readonly number[];
  end: readonly number[];
  started?: boolean;
  readonly ease: (value: number) => number;
  shakePath?: AdvDotweenShakePath;
}

/** Unity Transform.Euler uses the Z-X-Y composition order. */
const nativeEulerQuaternion = (euler: readonly number[]): readonly [number, number, number, number] => {
  const [sx, sy, sz] = euler.map((value) => Math.sin(value / 2));
  const [cx, cy, cz] = euler.map((value) => Math.cos(value / 2));
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
};
const nativeQuaternionEuler = (q: readonly number[]): readonly [number, number, number] => {
  const [x, y, z, w] = q;
  const rx = Math.asin(Math.max(-1, Math.min(1, 2 * (x * w - y * z))));
  if (Math.abs(Math.cos(rx)) < 0.000001) return [rx, Math.atan2(2 * (x * z + y * w), 1 - 2 * (y * y + z * z)), 0];
  return [
    rx,
    Math.atan2(2 * (x * z + y * w), 1 - 2 * (x * x + y * y)),
    Math.atan2(2 * (x * y + z * w), 1 - 2 * (x * x + z * z)),
  ];
};
const multiplyQuaternion = (a: readonly number[], b: readonly number[]): readonly [number, number, number, number] => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const scalarProperty = (property: StoryStillTween["property"]): boolean =>
  property === "rotation" || property === "positionZ" || property === "scaleZ" || property === "opacity";
/** Analytic sampling retains named nodes and does not replay earlier frames. */
export class StoryStillAnimator {
  private base: Readonly<Record<string, StoryStillPose>>;
  private poses: Readonly<Record<string, StoryStillPose>>;
  private sequence: StoryStillSequence | undefined;
  private tracks: readonly Track[] = [];
  private elapsed = 0;
  private shakePaths: Record<string, AdvDotweenShakePath> = {};
  private attachmentPending = false;
  private attachmentRevision = 0;
  private get formal(): boolean {
    return Boolean(this.presentation.layout.stillExternalLayout);
  }
  private attachedPosition(tween: StoryStillTween): boolean {
    return (
      this.formal &&
      (tween.property === "position" || tween.property === "positionZ") &&
      this.presentation.layout.nodes.some((node) => node.id === tween.node && !node.parent)
    );
  }
  revision = 0;
  private readonly programs = new Map<string, { animator: StoryStillAnimator; started: boolean; finished: boolean }>();
  private programSampling = false;
  private programHasUpdated = false;
  private readonly concurrentPrograms: boolean;
  constructor(
    readonly presentation: StoryStillPresentation,
    singleProgram = false,
  ) {
    this.concurrentPrograms = !singleProgram && presentation.sequences.some((sequence) => sequence.actions?.length);
    this.base = Object.fromEntries(
      presentation.layout.nodes.map((node) => [
        node.id,
        {
          position: [...node.position],
          scale: [...node.scale],
          size: [...node.size],
          rotation: node.rotation,
          ...(node.positionZ !== undefined ? { positionZ: node.positionZ } : {}),
          ...(node.scaleZ !== undefined ? { scaleZ: node.scaleZ } : {}),
          opacity: node.opacity,
          ...(node.image ? { imageColor: node.image.color } : {}),
          ...(node.rotationQuaternion ? { rotationEuler: nativeQuaternionEuler(node.rotationQuaternion) } : {}),
        },
      ]),
    );
    this.poses = this.base;
  }
  private worldRotation(
    nodeId: string,
    poses: Readonly<Record<string, StoryStillPose>>,
    cache = new Map<string, readonly number[]>(),
  ): readonly number[] {
    const found = cache.get(nodeId);
    if (found) {
      if (!found.length) throw new TypeError("Cyclic still rotation hierarchy");
      return found;
    }
    cache.set(nodeId, []);
    const node = this.presentation.layout.nodes.find((node) => node.id === nodeId);
    if (!node) throw new TypeError(`Still node is unavailable: ${nodeId}`);
    const pose = poses[nodeId];
    const local = pose.rotationEuler
      ? nativeEulerQuaternion(pose.rotationEuler)
      : (node.rotationQuaternion ?? nativeEulerQuaternion([0, 0, pose.rotation]));
    const world = pose.worldRotationEuler
      ? nativeEulerQuaternion(pose.worldRotationEuler)
      : node.parent
        ? multiplyQuaternion(this.worldRotation(node.parent, poses, cache), local)
        : local;
    cache.set(nodeId, world);
    return world;
  }
  get layout(): StoryFrameLayout {
    const cache = new Map<string, readonly number[]>();
    return {
      ...this.presentation.layout,
      nodes: this.presentation.layout.nodes.map((node) => {
        const pose = this.poses[node.id];
        let quaternion = pose.rotationEuler ? nativeEulerQuaternion(pose.rotationEuler) : node.rotationQuaternion;
        if (pose.worldRotationEuler) {
          const world = this.worldRotation(node.id, this.poses, cache);
          const parent = node.parent ? this.worldRotation(node.parent, this.poses, cache) : [0, 0, 0, 1];
          quaternion = multiplyQuaternion([-parent[0], -parent[1], -parent[2], parent[3]], world);
        }
        return {
          ...node,
          ...pose,
          size: pose.size ?? node.size,
          opacity: pose.opacity ?? node.opacity,
          positionZ: pose.positionZ ?? node.positionZ,
          scaleZ: pose.scaleZ ?? node.scaleZ,
          ...(node.image && pose.imageColor ? { image: { ...node.image, color: pose.imageColor } } : {}),
          ...(quaternion ? { rotationQuaternion: quaternion } : {}),
        };
      }),
    };
  }
  /** Actual SetStill boundary. Current Z changes now; anchored XY waits for real layout. */
  requestAttachment(): void {
    if (!this.formal) return;
    if(this.presentation.layout.nodes.some((node)=>!node.parent && (node.aspect?.mode===3 || node.aspect?.mode===4)))
      throw new TypeError("Still root fitter attachment ordering is unsupported");
    this.attachmentPending = true;
    this.attachmentRevision++;
    this.poses = Object.fromEntries(Object.entries(this.poses).map(([id, pose]) => [id,
      this.presentation.layout.nodes.some((node) => node.id === id && !node.parent) ? {...pose, positionZ: 0} : pose]));
    this.revision++;
  }
  /** Called only by the successful real canvas render-layout phase, including hidden instances. */
  consumeAttachment(width: number, height: number): void {
    const source = this.presentation.layout.stillExternalLayout;
    if (!source || !this.attachmentPending) return;
    const parent = resolveStoryStillExternalLayout(validateStoryStillExternalLayout(source), width, height).target;
    const F = Math.fround, [px,py,pw,ph] = parent.rect;
    const poses = {...this.poses};
    for (const node of this.presentation.layout.nodes) if (!node.parent) {
      const minX=F(px+F(node.anchorMin[0]*pw)),maxX=F(px+F(node.anchorMax[0]*pw));
      const minY=F(py+F(node.anchorMin[1]*ph)),maxY=F(py+F(node.anchorMax[1]*ph));
      const position: readonly [number,number]=node.transformKind==="transform"?[0,0]:
        [F(-F(minX+F(F(maxX-minX)*node.pivot[0]))),F(-F(minY+F(F(maxY-minY)*node.pivot[1])))];
      poses[node.id]={...poses[node.id]!,position};
    }
    this.poses=poses;this.attachmentPending=false;this.revision++;
  }
  play(index: number | string): void {
    if (this.concurrentPrograms) {
      const sequence =
        typeof index === "string"
          ? this.presentation.sequences.find((value) => value.id === index)
          : this.presentation.sequences[index];
      if (!sequence) throw new TypeError(`Still sequence is unavailable: ${index}`);
      const animator = this.restartProgram(sequence.id);
      const poses = { ...this.poses };
      for (const track of animator.tracks) {
        if (track.tween.at !== 0 || track.started === false) continue;
        const { node, property } = track.tween;
        poses[node] = { ...poses[node]!, [property]: animator.poses[node]![property] };
      }
      this.poses = poses;
      this.sequence = sequence;
      this.elapsed = 0;
      this.revision++;
      return;
    }
    const selected =
      typeof index === "string"
        ? this.presentation.sequences.find((sequence) => sequence.id === index)
        : this.presentation.sequences[index];
    if (selected?.loop && selected.tweens.some((tween) => this.attachedPosition(tween)))
      throw new TypeError("Still looping root position requires component restart callback support");
    this.shakePaths = {};
    this.base = this.poses;
    this.elapsed = 0;
    this.sequence =
      typeof index === "string"
        ? this.presentation.sequences.find((sequence) => sequence.id === index)
        : this.presentation.sequences[index];
    if (this.sequence?.unsupportedFeatures?.length)
      throw new Error(`Still sequence ${this.sequence.id} requires: ${this.sequence.unsupportedFeatures.join(", ")}`);
    this.compile();
    this.sample(0, !this.formal);
  }
  stop(): void {
    this.programs.clear();
    this.base = this.poses;
    this.sequence = undefined;
    this.tracks = [];
    this.shakePaths = {};
    this.elapsed = 0;
  }
  update(deltaSeconds: number): void {
    if (this.concurrentPrograms) {
      if (Number.isFinite(deltaSeconds) && deltaSeconds > 0) this.updatePrograms(deltaSeconds);
      return;
    }
    if (!this.sequence || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    const duration = this.sequence.duration;
    const previous = this.elapsed;
    const next =
      this.sequence.loop && duration > 0
        ? (this.elapsed + deltaSeconds) % duration
        : Math.min(duration, this.elapsed + deltaSeconds);
    if (
      next === this.elapsed &&
      !(this.formal && this.tracks.some((track) => !track.started && track.tween.at <= next))
    )
      return;
    this.elapsed = next;
    this.sample(next, true, previous);
  }
  snapshot(): StoryStillAnimationSnapshot {
    if (this.concurrentPrograms) {
      const primary = this.sequence && this.programs.get(this.sequence.id);
      const state = primary ? primary.animator.snapshot() : this.snapshotSingle();
      return {
        ...state,
        current: this.poses,
        attachment: { pending: this.attachmentPending, revision: this.attachmentRevision },
        programs: [...this.programs.values()].map((run) => ({
          state: run.animator.snapshot(),
          started: run.started,
          finished: run.finished,
        })),
      };
    }
    return this.snapshotSingle();
  }
  private snapshotSingle(): StoryStillAnimationSnapshot {
    return {
      sequence: this.sequence?.id ?? null,
      elapsed: this.elapsed,
      base: this.base,
      shakePaths: this.shakePaths,
      ...(this.formal
        ? {
            current: this.poses,
            captures: this.tracks.map((track) => ({
              started: Boolean(track.started),
              start: [...track.start],
              end: [...track.end],
            })),
            attachment: { pending: this.attachmentPending, revision: this.attachmentRevision },
          }
        : {}),
    };
  }
  restore(snapshot: StoryStillAnimationSnapshot): void {
    this.restoreSingle(snapshot);
    this.programs.clear();
    if (snapshot.programs !== undefined) {
      if (!this.concurrentPrograms || !Array.isArray(snapshot.programs))
        throw new TypeError("Invalid Still program snapshot");
      for (const saved of snapshot.programs) {
        const id = saved.state.sequence;
        if (
          id === null ||
          this.programs.has(id) ||
          typeof saved.started !== "boolean" ||
          typeof saved.finished !== "boolean" ||
          saved.state.programs
        )
          throw new TypeError("Invalid Still program state");
        const animator = new StoryStillAnimator(this.presentation, true);
        animator.restoreSingle(saved.state);
        animator.programSampling = true;
        animator.programHasUpdated = saved.started;
        this.programs.set(id, { animator, started: saved.started, finished: saved.finished });
      }
      if (snapshot.sequence !== null && !this.programs.has(snapshot.sequence))
        throw new TypeError("Missing Still primary program");
    } else if (this.concurrentPrograms && snapshot.sequence !== null)
      throw new TypeError("Missing Still program snapshot");
  }
  private restoreSingle(snapshot: StoryStillAnimationSnapshot): void {
    const base = snapshot.base;
    if (
      !Number.isFinite(snapshot.elapsed) ||
      snapshot.elapsed < 0 ||
      this.presentation.layout.nodes.some((node) => {
        const pose = base[node.id];
        return (
          !Object.hasOwn(base, node.id) ||
          !pose ||
          !Array.isArray(pose.position) ||
          pose.position.length !== 2 ||
          !Array.isArray(pose.scale) ||
          pose.scale.length !== 2 ||
          ![
            ...pose.position,
            ...pose.scale,
            ...(pose.size ?? []),
            pose.rotation,
            pose.positionZ ?? 0,
            pose.scaleZ ?? 1,
            pose.opacity ?? 1,
            ...(pose.imageColor ?? []),
            ...(pose.rotationEuler ?? []),
            ...(pose.worldRotationEuler ?? []),
          ].every(Number.isFinite) ||
          (pose.size !== undefined && pose.size.length !== 2) ||
          (pose.rotationEuler !== undefined && pose.rotationEuler.length !== 3) ||
          (pose.imageColor !== undefined && pose.imageColor.length !== 4) ||
          (pose.worldRotationEuler !== undefined && pose.worldRotationEuler.length !== 3)
        );
      })
    )
      throw new TypeError("Invalid still animation state");
    const sequence =
      snapshot.sequence === null
        ? undefined
        : this.presentation.sequences.find((sequence) => sequence.id === snapshot.sequence);
    if (snapshot.sequence !== null && !sequence)
      throw new TypeError(`Still sequence is unavailable: ${snapshot.sequence}`);
    if (sequence?.unsupportedFeatures?.length)
      throw new Error(`Still sequence ${sequence.id} requires: ${sequence.unsupportedFeatures.join(", ")}`);
    if(sequence?.loop && sequence.tweens.some((tween)=>this.attachedPosition(tween)))
      throw new TypeError("Still looping root position requires component restart callback support");
    if (this.formal) {
      if (!snapshot.current || !snapshot.captures || snapshot.captures.length!==(sequence?.tweens.length??0) || !snapshot.attachment ||
          typeof snapshot.attachment.pending!=="boolean" || !Number.isSafeInteger(snapshot.attachment.revision) || snapshot.attachment.revision<0)
        throw new TypeError("Missing Still attachment snapshot");
      for (const node of this.presentation.layout.nodes) {
        const pose=snapshot.current[node.id];
        if (!pose || !Array.isArray(pose.position) || pose.position.length!==2 || !Array.isArray(pose.scale) || pose.scale.length!==2 ||
            (pose.size!==undefined && (!Array.isArray(pose.size) || pose.size.length!==2)) ||
            (pose.rotationEuler!==undefined && (!Array.isArray(pose.rotationEuler) || pose.rotationEuler.length!==3)) ||
            (pose.worldRotationEuler!==undefined && (!Array.isArray(pose.worldRotationEuler) || pose.worldRotationEuler.length!==3)) ||
            (pose.imageColor!==undefined && (!Array.isArray(pose.imageColor) || pose.imageColor.length!==4)) ||
            ![...pose.position,...pose.scale,...(pose.size??[]),pose.rotation,pose.positionZ??0,pose.scaleZ??1,pose.opacity??1,
              ...(pose.rotationEuler??[]),...(pose.worldRotationEuler??[]),...(pose.imageColor??[])].every(Number.isFinite))
          throw new TypeError("Invalid Still current snapshot");
      }
      const tweens=[...(sequence?.tweens??[])].sort((a,b)=>a.at-b.at);
      snapshot.captures.forEach((capture,index)=>{
        const tween=tweens[index]!;
        if (typeof capture.started!=="boolean" || !Array.isArray(capture.start) || !Array.isArray(capture.end) ||
            (capture.started ? capture.start.length!==tween.value.length || capture.end.length!==capture.start.length : capture.start.length!==0 || capture.end.length!==0) ||
            ![...capture.start,...capture.end].every(Number.isFinite)) throw new TypeError("Invalid Still track capture");
      });
    }
    this.base = base;
    this.sequence = sequence;
    this.elapsed = snapshot.elapsed;
    this.shakePaths = { ...snapshot.shakePaths };
    for (const path of Object.values(this.shakePaths)) {
      if (!Array.isArray(path.points) || !Array.isArray(path.cumulativeDurations) ||
        path.points.length !== path.cumulativeDurations.length || path.points.length === 0 ||
        path.points.some((point) => ![point.x, point.y, point.z].every(Number.isFinite)) ||
        path.cumulativeDurations.some((end, index) => !Number.isFinite(end) || end <= 0 || end > 1 ||
          (index > 0 && end <= path.cumulativeDurations[index - 1]!)) ||
        path.cumulativeDurations.at(-1) !== 1) throw new TypeError("Invalid still shake snapshot");
    }
    this.compile(true);
    if (this.formal) {
      snapshot.captures!.forEach((capture,index)=>{
        const track=this.tracks[index]!;
        if (typeof capture.started!=="boolean" || (capture.started && (capture.start.length!==track.tween.value.length || capture.end.length!==capture.start.length)) ||
            ![...capture.start,...capture.end].every(Number.isFinite)) throw new TypeError("Invalid Still track capture");
        track.started=capture.started;track.start=[...capture.start];track.end=[...capture.end];
        const path=this.shakePaths[String(index)];if(path)track.shakePath=path;
      });
      this.poses=snapshot.current!;this.attachmentPending=snapshot.attachment!.pending;this.attachmentRevision=snapshot.attachment!.revision;this.revision++;
    } else this.sample(this.elapsed);
  }
  private killProgram(id: string, seen = new Set<string>()): void {
    if (seen.has(id)) return;
    seen.add(id);
    this.programs.delete(id);
    for (const child of this.presentation.sequences.find((sequence) => sequence.id === id)?.killWith ?? [])
      this.killProgram(child, seen);
  }
  private restartProgram(id: string): StoryStillAnimator {
    const sequence = this.presentation.sequences.find((value) => value.id === id);
    if (!sequence) throw new TypeError(`Still callback sequence is unavailable: ${id}`);
    for (const action of sequence.actions ?? []) {
      if (
        !Number.isFinite(action.at) ||
        action.at < 0 ||
        action.at > sequence.duration ||
        action.operation !== "restart" ||
        !this.presentation.sequences.some((value) => value.id === action.sequence)
      )
        throw new TypeError("Invalid Still timeline action");
    }
    this.killProgram(id);
    const animator = new StoryStillAnimator(this.presentation, true);
    animator.poses = this.poses;
    animator.play(id);
    animator.programSampling = true;
    this.programs.set(id, { animator, started: false, finished: false });
    return animator;
  }
  private updatePrograms(delta: number): void {
    // Newly created programs join the next real update, matching the native tween manager's active iteration.
    for (const [id, run] of [...this.programs]) {
      if (this.programs.get(id) !== run || run.finished) continue;
      const animator = run.animator,
        sequence = animator.sequence!,
        previous = animator.elapsed;
      const next = Math.min(sequence.duration, Math.fround(previous + Math.fround(delta))),
        first = !run.started;
      animator.poses = this.poses;
      animator.elapsed = next;
      animator.sample(next, true, previous);
      animator.programHasUpdated = true;
      this.poses = animator.poses;
      run.started = true;
      for (const action of sequence.actions ?? []) {
        if (this.programs.get(id) !== run) break;
        if (action.at <= next && (first || action.at > previous)) this.restartProgram(action.sequence);
      }
      if (this.programs.get(id) !== run) continue;
      if (next >= sequence.duration) {
        if (sequence.loop && sequence.duration > 0) {
          // Fwk completion calls DORestart: rewind and discard the overshoot.
          const poses = { ...this.poses };
          for (const track of [...animator.tracks].reverse())
            if (track.started !== false) {
              const values = track.start;
              if (!values.length) continue;
              poses[track.tween.node] = {
                ...poses[track.tween.node]!,
                [track.tween.property]: scalarProperty(track.tween.property) ? values[0] : [...values],
              };
            }
          this.poses = poses;
          animator.poses = poses;
          animator.elapsed = 0;
          animator.programHasUpdated = false;
          run.started = false;
        } else run.finished = true;
      }
    }
    const primary = this.sequence && this.programs.get(this.sequence.id);
    if (primary) this.elapsed = primary.animator.elapsed;
    this.revision++;
  }
  private compile(restoring = false): void {
    const tracks: Track[] = [];
    for (const tween of [...(this.sequence?.tweens ?? [])].sort((a, b) => a.at - b.at)) {
      if (
        ![
          "position",
          "scale",
          "size",
          "rotation",
          "positionZ",
          "scaleZ",
          "rotationEuler",
          "worldRotationEuler",
          "opacity",
          "imageColor",
        ].includes(tween.property) ||
        ![tween.at, tween.duration, tween.ease].every(Number.isFinite) ||
        tween.at < 0 ||
        tween.duration < 0 ||
        (tween.iterations !== undefined && (!Number.isSafeInteger(tween.iterations) || tween.iterations < 1)) ||
        (tween.loopMode !== undefined && tween.loopMode !== "restart" && tween.loopMode !== "yoyo") ||
        tween.value.length !==
          (scalarProperty(tween.property)
            ? 1
            : tween.property === "rotationEuler" || tween.property === "worldRotationEuler"
              ? 3
              : tween.property === "imageColor"
                ? 4
                : 2) ||
        !tween.value.every(Number.isFinite)
      )
        throw new TypeError("Invalid still tween");
      const pose = this.base[tween.node];
      if (!Object.hasOwn(this.base, tween.node) || !pose)
        throw new TypeError(`Still tween node is unavailable: ${tween.node}`);
      if (this.attachedPosition(tween)) {
        tracks.push({tween,start:[],end:[],started:false,ease:resolveEase(tween.ease)});
        continue;
      }
      let start: readonly number[] =
        tween.property === "worldRotationEuler"
          ? nativeQuaternionEuler(this.worldRotation(tween.node, this.base))
          : tween.property === "rotationEuler"
            ? (pose.rotationEuler ?? [0, 0, pose.rotation])
            : tween.property === "positionZ"
              ? [pose.positionZ ?? 0]
              : tween.property === "scaleZ"
                ? [pose.scaleZ ?? 1]
                : tween.property === "opacity"
                  ? [pose.opacity ?? 1]
                  : tween.property === "imageColor"
                    ? (pose.imageColor ?? [1, 1, 1, 1])
                    : tween.property === "rotation"
                      ? [pose.rotation]
                      : tween.property === "size"
                        ? (pose.size ?? this.presentation.layout.nodes.find((node) => node.id === tween.node)!.size)
                        : pose[tween.property];
      for (const track of tracks)
        if (track.tween.node === tween.node && track.tween.property === tween.property)
          start = this.value(track, tween.at);
      let end = tween.value.map((value, index) => value + (tween.relative ? start[index]! : 0));
      if (tween.from) {
        const previous = start;
        start = end;
        end = [...previous];
      }
      if (tween.property === "worldRotationEuler" && tween.rotationMode === "fast" && !tween.relative)
        end = end.map(
          (value, index) => start[index] + Math.atan2(Math.sin(value - start[index]), Math.cos(value - start[index])),
        );
      let shakePath: AdvDotweenShakePath | undefined;
      if (tween.shake) {
        if (tween.property !== "position" || ![tween.shake.strength, tween.shake.vibrato, tween.shake.randomness].every(Number.isFinite) ||
          tween.shake.vibrato < 1 || tween.duration <= 0) throw new TypeError("Invalid still shake tween");
        const key = String(tracks.length);
        shakePath = this.shakePaths[key];
        if (!shakePath && restoring) throw new TypeError("Still shake snapshot path is missing");
        if (!shakePath) this.shakePaths[key] = shakePath = createAdvDotweenShakePath({
          duration: tween.duration, strength: tween.shake.strength, vibrato: tween.shake.vibrato,
          randomness: tween.shake.randomness, fadeOut: tween.shake.fadeOut, vectorBased: true,
        });
      }
      tracks.push({ tween, start: [...start], end, ...(this.formal?{started:true}:{}), ease: resolveEase(tween.ease), ...(shakePath ? { shakePath } : {}) });
    }
    this.tracks = tracks;
  }
  private value(track: Track, time: number): readonly number[] {
    const { duration } = track.tween;
    const iterations = track.tween.iterations ?? 1;
    const elapsed = Math.max(0, time - track.tween.at);
    let cycle = 0;
    let progress = 1;
    if (duration > 0) {
      const clamped = Math.min(elapsed, duration * iterations);
      cycle = Math.floor(clamped / duration);
      progress = (clamped - cycle * duration) / duration;
      // A cycle boundary samples the completed cycle's endpoint.
      if (clamped > 0 && (progress === 0 || cycle >= iterations)) {
        cycle = Math.min(cycle, iterations) - 1;
        progress = 1;
      }
    } else cycle = iterations - 1;
    if (track.tween.loopMode === "yoyo" && cycle % 2 === 1) progress = 1 - progress;
    if (track.shakePath) {
      const offset = sampleAdvDotweenShake(track.shakePath, progress);
      return [track.start[0]! + offset.x, track.start[1]! + offset.y];
    }
    const eased = track.ease(progress);
    return track.start.map((start, index) => start + (track.end[index]! - start) * eased);
  }
  private sample(time: number, actualSetter = true, fromTime = 0): void {
    const poses: Record<string, StoryStillPose> = { ...(this.programSampling ? this.poses : this.base) };
    if(this.formal) for(const node of this.presentation.layout.nodes) if(!node.parent) {
      const current=this.poses[node.id]!;
      poses[node.id]={...poses[node.id]!,position:current.position,positionZ:current.positionZ};
    }
    for (const track of this.tracks) {
      if (time < track.tween.at) continue;
      const end = track.tween.at + track.tween.duration * (track.tween.iterations ?? 1);
      if (this.programSampling && this.programHasUpdated && time >= fromTime && fromTime >= end) continue;
      if(this.attachedPosition(track.tween)) {
        const at=track.tween.at,end=at+track.tween.duration*(track.tween.iterations??1);
        if(!actualSetter || (at>0?end<=fromTime:end<fromTime)) continue;
      }
      if (this.formal && !track.started) {
        if (!actualSetter) continue;
        const pose=poses[track.tween.node]!,tween=track.tween;
        const start=tween.property==="worldRotationEuler"?nativeQuaternionEuler(this.worldRotation(tween.node,poses)):
          tween.property==="rotationEuler"?(pose.rotationEuler??[0,0,pose.rotation]):
          tween.property==="positionZ"?[pose.positionZ??0]:tween.property==="scaleZ"?[pose.scaleZ??1]:
          tween.property==="opacity"?[pose.opacity??1]:tween.property==="imageColor"?(pose.imageColor??[1,1,1,1]):
          tween.property==="rotation"?[pose.rotation]:tween.property==="size"?(pose.size??this.presentation.layout.nodes.find((node)=>node.id===tween.node)!.size):pose[tween.property];
        let end=tween.value.map((value,index)=>value+(tween.relative?start[index]!:0));
        track.start=[...start];track.end=end;
        if(tween.from){track.start=end;track.end=[...start];}
        if(tween.property==="worldRotationEuler" && tween.rotationMode==="fast" && !tween.relative)
          track.end=track.end.map((value,index)=>track.start[index]!+Math.atan2(Math.sin(value-track.start[index]!),Math.cos(value-track.start[index]!)));
        if(tween.shake){
          if(tween.property!=="position" || ![tween.shake.strength,tween.shake.vibrato,tween.shake.randomness].every(Number.isFinite) || tween.shake.vibrato<1 || tween.duration<=0)
            throw new TypeError("Invalid still shake tween");
          const key=String(this.tracks.indexOf(track));
          track.shakePath=this.shakePaths[key]??createAdvDotweenShakePath({duration:tween.duration,strength:tween.shake.strength,vibrato:tween.shake.vibrato,randomness:tween.shake.randomness,fadeOut:tween.shake.fadeOut,vectorBased:true});
          this.shakePaths[key]=track.shakePath;
        }
        track.started=true;
      }
      const values = this.value(track, time),
        pose = poses[track.tween.node]!;
      poses[track.tween.node] = {
        ...pose,
        [track.tween.property]: scalarProperty(track.tween.property) ? values[0] : [...values],
      };
    }
    this.poses = poses;
    this.revision++;
  }
}
