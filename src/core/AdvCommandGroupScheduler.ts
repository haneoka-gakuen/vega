import type { AdvCommand, AdvCommandGroup, AdvCommandGroupAction } from "../types/AdvRuntime";
import { resolveAdvCommandGroup, sortAdvCommandGroupActions } from "./AdvCommandGroup";
import { createAdvSettlingWait } from "./AdvSettlingWait";

export interface AdvCommandGroupSchedulerOptions {
  execute: (
    command: AdvCommand,
    signal: AbortSignal,
  ) => {
    completion: Promise<void> | void;
    detached: readonly Promise<void>[];
  };
  delay: (seconds: number, signal: AbortSignal) => Promise<void>;
  onError?: (error: unknown) => void;
}

interface AdvCommandGroupEventOwner {
  readonly controller: AbortController;
  readonly parent: AdvCommandGroupOwner;
  done: Promise<void>;
}

interface AdvCommandGroupPendingEvent {
  readonly controller: AbortController;
  triggered: boolean;
}

interface AdvCommandGroupOwner {
  readonly controller: AbortController;
  readonly cancelOnManualAdvance: boolean;
  readonly pendingEvents: Set<AdvCommandGroupPendingEvent>;
  runningEvents: number;
  active: boolean;
  done: Promise<void>;
}

interface CueBoundaries {
  start: ReturnType<typeof createAdvSettlingWait>;
  end: ReturnType<typeof createAdvSettlingWait>;
  remaining: number;
  targets: Set<string>;
}

function cueBoundaries(actions: readonly AdvCommandGroupAction[]): Map<string, CueBoundaries> {
  const cues = new Map<string, CueBoundaries>();
  for (const action of actions) {
    if (!action.cueId) continue;
    let cue = cues.get(action.cueId);
    if (!cue) {
      cue = { start: createAdvSettlingWait(), end: createAdvSettlingWait(), remaining: 0, targets: new Set() };
      cues.set(action.cueId, cue);
    }
    cue.remaining++;
    if (action.anchor) cue.targets.add(action.anchor.nodeId);
  }
  const valid = new Map<string, boolean>();
  const reachesBoundary = (id: string): boolean => {
    if (valid.has(id)) return valid.get(id)!;
    valid.set(id, false);
    const cue = cues.get(id);
    const complete = Boolean(cue && [...cue.targets].every(reachesBoundary));
    valid.set(id, complete);
    return complete;
  };
  for (const id of cues.keys()) reachesBoundary(id);
  for (const [id, complete] of valid) if (!complete) cues.delete(id);
  return cues;
}

function finishCue(cue: CueBoundaries | undefined): void {
  if (cue && --cue.remaining === 0) cue.end.settle();
}

function linkedAbortController(parent?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (!parent) return controller;
  if (parent.aborted) {
    controller.abort();
    return controller;
  }
  const abort = (): void => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  controller.signal.addEventListener("abort", () => parent.removeEventListener("abort", abort), { once: true });
  if (parent.aborted) controller.abort();
  return controller;
}

async function waitForTasks(tasks: readonly Promise<void>[], signal?: AbortSignal): Promise<void> {
  if (!tasks.length || signal?.aborted) return;
  if (!signal) {
    await Promise.all(tasks);
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    void Promise.all(tasks).then(finish, finish);
    if (signal.aborted) finish();
  });
}

/** Runtime scheduler for source-neutral concurrent command groups. */
export class AdvCommandGroupScheduler {
  private readonly execute: AdvCommandGroupSchedulerOptions["execute"];
  private readonly delay: AdvCommandGroupSchedulerOptions["delay"];
  private readonly onError?: AdvCommandGroupSchedulerOptions["onError"];
  private readonly active = new Set<AdvCommandGroupOwner>();
  private readonly runningEvents = new Set<AdvCommandGroupEventOwner>();
  private readonly actionSignals = new WeakSet<AbortSignal>();
  private generation = 0;

  constructor(options: AdvCommandGroupSchedulerOptions) {
    this.execute = options.execute;
    this.delay = options.delay;
    this.onError = options.onError;
  }

  get hasActive(): boolean {
    return this.active.size > 0;
  }

  get hasPendingWork(): boolean {
    return this.active.size > 0 || this.runningEvents.size > 0;
  }

  /** Admit a group, optionally holding the script until the group's lifetime ends. */
  async admit(value: AdvCommandGroup | null | undefined, signal?: AbortSignal): Promise<void> {
    const group = resolveAdvCommandGroup(value);
    if (!group || signal?.aborted) return;
    const generation = this.generation;
    if (group.waitForPrevious && (!signal || !this.actionSignals.has(signal))) await this.waitForIdle(signal);
    if (signal?.aborted || generation !== this.generation) return;

    const owner = this.createOwner(group, signal);
    owner.done = this.runGroup(owner, group).finally(() => this.finishOwner(owner));
    if (group.waitForCompletion) await owner.done;
  }

  /** Execute a group's actions immediately in stable chronological order. */
  async admitImmediate(value: AdvCommandGroup | null | undefined, signal?: AbortSignal): Promise<void> {
    const group = resolveAdvCommandGroup(value);
    if (!group || signal?.aborted) return;
    const generation = this.generation;
    if (group.waitForPrevious && (!signal || !this.actionSignals.has(signal))) await this.waitForIdle(signal);
    if (signal?.aborted || generation !== this.generation) return;

    const owner = this.createOwner(group, signal);
    owner.done = this.runImmediate(owner, group).finally(() => this.finishOwner(owner));
    await owner.done;
  }

  async waitForIdle(signal?: AbortSignal): Promise<void> {
    while (this.active.size && !signal?.aborted) {
      await waitForTasks(
        [...this.active].map((owner) => owner.done),
        signal,
      );
    }
  }

  async waitForSettled(signal?: AbortSignal): Promise<void> {
    while (this.hasPendingWork && !signal?.aborted) {
      await waitForTasks(
        [...this.active].map((owner) => owner.done).concat([...this.runningEvents].map((owner) => owner.done)),
        signal,
      );
    }
  }

  cancelAll(): void {
    this.generation += 1;
    for (const owner of this.active) owner.controller.abort();
    for (const event of this.runningEvents) event.controller.abort();
  }

  /** Broadcast an explicit user advance to groups that opt into cancellation. */
  requestManualAdvance(): void {
    for (const owner of this.active) {
      if (owner.cancelOnManualAdvance) owner.controller.abort();
    }
  }

  private createOwner(group: AdvCommandGroup, signal?: AbortSignal): AdvCommandGroupOwner {
    const owner: AdvCommandGroupOwner = {
      controller: linkedAbortController(signal),
      cancelOnManualAdvance: group.cancelOnManualAdvance,
      pendingEvents: new Set(),
      runningEvents: 0,
      active: true,
      done: Promise.resolve(),
    };
    this.active.add(owner);
    return owner;
  }

  private finishOwner(owner: AdvCommandGroupOwner): void {
    owner.active = false;
    this.active.delete(owner);
    this.releaseOwnerWhenSettled(owner);
  }

  private async runGroup(owner: AdvCommandGroupOwner, group: AdvCommandGroup): Promise<void> {
    const actions = sortAdvCommandGroupActions(group.actions);
    const cues = cueBoundaries(actions);
    const required: Promise<void>[] = [];
    for (const action of actions) {
      if (action.role === "lifetime") {
        required.push(this.runLifetimeAction(owner, action, cues));
      } else {
        const scheduled = this.scheduleEvent(owner, action, cues);
        if (group.waitForCompletion || (action.cueId && cues.has(action.cueId))) required.push(scheduled);
      }
    }
    const durationController = linkedAbortController(owner.controller.signal);
    try {
      await Promise.all([this.delay(group.durationSeconds, durationController.signal), ...required]);
    } catch (error) {
      this.report(error);
    } finally {
      durationController.abort();
      for (const event of owner.pendingEvents) {
        if (!event.triggered) event.controller.abort();
      }
      owner.pendingEvents.clear();
    }
  }

  private async runImmediate(owner: AdvCommandGroupOwner, group: AdvCommandGroup): Promise<void> {
    const signal = owner.controller.signal;
    this.actionSignals.add(signal);
    for (const action of sortAdvCommandGroupActions(group.actions)) {
      if (signal.aborted) break;
      if (action.suppressed) continue;
      try {
        const result = this.execute(action.command, signal);
        await result.completion;
        await waitForTasks(result.detached, signal);
      } catch (error) {
        this.report(error);
      }
    }
  }

  private async waitForCue(
    action: AdvCommandGroupAction,
    cues: ReadonlyMap<string, CueBoundaries>,
    signal: AbortSignal,
  ): Promise<void> {
    const anchor = action.cueId && cues.has(action.cueId) ? action.anchor : undefined;
    const target = anchor ? cues.get(anchor.nodeId) : undefined;
    if (anchor && target) {
      await waitForTasks([target[anchor.point].promise], signal);
      if (anchor.offsetSeconds > 0 && !signal.aborted) await this.delay(anchor.offsetSeconds, signal);
    } else if (action.atSeconds > 0) {
      await this.delay(action.atSeconds, signal);
    }
  }

  private async runLifetimeAction(
    owner: AdvCommandGroupOwner,
    action: AdvCommandGroupAction,
    cues: ReadonlyMap<string, CueBoundaries>,
  ): Promise<void> {
    const controller = linkedAbortController(owner.controller.signal);
    this.actionSignals.add(controller.signal);
    const cue = action.cueId ? cues.get(action.cueId) : undefined;
    let detached: readonly Promise<void>[] = [];
    try {
      if (action.anchor || action.atSeconds > 0) await this.waitForCue(action, cues, controller.signal);
      cue?.start.settle();
      if (action.suppressed) {
        if (action.minimumEndSeconds) await this.delay(action.minimumEndSeconds, controller.signal);
      } else if (!controller.signal.aborted) {
        const result = this.execute(action.command, controller.signal);
        detached = action.minimumEndSeconds
          ? [...result.detached, this.delay(action.minimumEndSeconds, controller.signal)]
          : result.detached;
        await result.completion;
      }
    } catch (error) {
      this.report(error);
    } finally {
      if (detached.length) this.trackEvent(owner, controller, waitForTasks(detached, controller.signal), cue);
      else {
        finishCue(cue);
        controller.abort();
      }
    }
  }

  private async scheduleEvent(
    owner: AdvCommandGroupOwner,
    action: AdvCommandGroupAction,
    cues: ReadonlyMap<string, CueBoundaries>,
  ): Promise<void> {
    const pending: AdvCommandGroupPendingEvent = {
      controller: linkedAbortController(owner.controller.signal),
      triggered: false,
    };
    owner.pendingEvents.add(pending);
    const cue = action.cueId ? cues.get(action.cueId) : undefined;
    try {
      if (action.anchor || action.atSeconds > 0) await this.waitForCue(action, cues, pending.controller.signal);
      if (pending.controller.signal.aborted || !owner.active) return;
      pending.triggered = true;
      owner.pendingEvents.delete(pending);
      this.startEvent(owner, action, cue);
    } catch (error) {
      this.report(error);
    } finally {
      if (!pending.triggered) {
        cue?.start.settle();
        finishCue(cue);
      }
      pending.controller.abort();
      owner.pendingEvents.delete(pending);
    }
  }

  private startEvent(owner: AdvCommandGroupOwner, action: AdvCommandGroupAction, cue?: CueBoundaries): void {
    const controller = linkedAbortController(owner.controller.signal);
    this.actionSignals.add(controller.signal);
    cue?.start.settle();
    let done: Promise<void>;
    try {
      const result = action.suppressed ? undefined : this.execute(action.command, controller.signal);
      done = Promise.all([
        result?.completion,
        result && waitForTasks(result.detached, controller.signal),
        action.minimumEndSeconds && this.delay(action.minimumEndSeconds, controller.signal),
      ]).then(() => undefined);
    } catch (error) {
      done = Promise.reject(error);
    }
    this.trackEvent(owner, controller, done, cue);
  }

  private trackEvent(
    owner: AdvCommandGroupOwner,
    controller: AbortController,
    done: Promise<void>,
    cue?: CueBoundaries,
  ): void {
    owner.runningEvents += 1;
    const event: AdvCommandGroupEventOwner = { controller, parent: owner, done: Promise.resolve() };
    this.runningEvents.add(event);
    event.done = done
      .then(
        () => undefined,
        (error) => this.report(error),
      )
      .finally(() => {
        finishCue(cue);
        controller.abort();
        this.runningEvents.delete(event);
        owner.runningEvents = Math.max(0, owner.runningEvents - 1);
        this.releaseOwnerWhenSettled(owner);
      });
  }

  private releaseOwnerWhenSettled(owner: AdvCommandGroupOwner): void {
    if (!owner.active && owner.runningEvents === 0) owner.controller.abort();
  }

  private report(error: unknown): void {
    this.onError?.(error);
  }
}
