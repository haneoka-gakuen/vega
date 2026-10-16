import initialize, { VegaExecution } from "../generated/vega_wasm.js";
import type { VegaCheckpointExecutionDriver, VegaExecutionOwnershipDriver, VegaExecutionRecord } from "./ports";
import { executionCheckpointFromWords, type VegaExecutionCheckpoint } from "@haneoka/vega-protocol";

let initialization: Promise<unknown> | undefined;

const record = (values: Float64Array): VegaExecutionRecord =>
  Object.freeze({
    executionId: values[0],
    commandIndex: values[1],
    startedAtUs: values[2],
    ...(values[3] < 0 ? {} : { completedAtUs: values[3] }),
    ...(values[4] < 0 ? {} : { nextCommandIndex: values[4] }),
    ...(values[5] < 0 ? {} : { waitForCompletion: values[5] !== 0 }),
    endsSequence: values[6] !== 0,
  });

class RustVegaExecutionDriver implements VegaCheckpointExecutionDriver, VegaExecutionOwnershipDriver {
  private disposed = false;
  constructor(private readonly session: VegaExecution) {}
  private active(): VegaExecution {
    if (this.disposed) throw new ReferenceError("Vega execution driver disposed");
    return this.session;
  }
  get cursor(): number {
    return this.active().cursor;
  }
  get generation(): number {
    return this.active().generation;
  }
  get playing(): boolean {
    return this.active().playing;
  }
  get paused(): boolean {
    return this.active().paused;
  }
  get blockingExecutionId(): number | null {
    const session = this.active();
    if (!("blockingExecutionId" in session)) throw new Error("vega_execution_ownership_unavailable");
    return (Reflect.get(session, "blockingExecutionId") as number | undefined) ?? null;
  }
  get history(): readonly VegaExecutionRecord[] {
    const session = this.active();
    return Object.freeze(Array.from({ length: session.historyCount }, (_, id) => record(session.record(id))));
  }
  start(): boolean {
    return this.active().start();
  }
  begin(atUs: number): VegaExecutionRecord {
    return record(this.active().begin(atUs));
  }
  admit(id: number, waitForCompletion: boolean): void {
    this.active().admit(id, waitForCompletion);
  }
  complete(id: number, atUs: number, next?: number, endsSequence = false): void {
    this.active().complete(id, atUs, next, endsSequence);
  }
  reposition(position: number): void {
    this.active().reposition(position);
  }
  captureCheckpoint(): VegaExecutionCheckpoint {
    return executionCheckpointFromWords(this.active().captureCheckpoint());
  }
  restoreCheckpoint(checkpoint: VegaExecutionCheckpoint): void {
    this.active().restoreCheckpoint(Float64Array.from(checkpoint.words));
  }
  forkReplay(checkpoint: VegaExecutionCheckpoint): VegaCheckpointExecutionDriver {
    const indices = checkpoint.words.slice(5, 5 + checkpoint.commandCount);
    const fork = new RustVegaExecutionDriver(new VegaExecution(Uint32Array.from(indices)));
    try {
      fork.restoreCheckpoint(checkpoint);
      fork.active().setReplayMode(true);
      fork.start();
      return fork;
    } catch (error) {
      fork.dispose();
      throw error;
    }
  }
  pause(): void {
    this.active().pause();
  }
  resume(): void {
    this.active().resume();
  }
  stop(): void {
    this.active().stop();
  }
  finish(): void {
    this.active().finish();
  }
  dispose(): void {
    if (this.disposed) return;
    this.session.stop();
    this.disposed = true;
    this.session.free();
  }
}

/** Initializes one shared module and creates an independently owned Rust session. */
export const createRustVegaExecutionDriver = async (indices: readonly number[]): Promise<VegaCheckpointExecutionDriver & VegaExecutionOwnershipDriver> => {
  if (indices.some((index) => !Number.isSafeInteger(index) || index < 0 || index > 0xffffffff)) {
    throw new TypeError("Vega execution indices must be unsigned 32-bit integers");
  }
  initialization ??= initialize().catch((error: unknown) => {
    initialization = undefined;
    throw error;
  });
  await initialization;
  return new RustVegaExecutionDriver(new VegaExecution(Uint32Array.from(indices)));
};
