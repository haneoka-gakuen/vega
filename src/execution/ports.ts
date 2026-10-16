export interface VegaExecutionRecord {
  readonly executionId: number;
  readonly commandIndex: number;
  readonly startedAtUs: number;
  readonly completedAtUs?: number;
  readonly nextCommandIndex?: number;
  readonly waitForCompletion?: boolean;
  readonly endsSequence?: boolean;
}

/** Source-neutral execution admission; media/commands are owned by the host. */
export interface VegaExecutionDriver {
  readonly cursor: number;
  readonly generation: number;
  readonly playing: boolean;
  readonly paused: boolean;
  readonly history: readonly VegaExecutionRecord[];
  start(): boolean;
  begin(atUs: number): VegaExecutionRecord;
  admit(executionId: number, waitForCompletion: boolean): void;
  complete(executionId: number, atUs: number, nextCommandIndex?: number, endsSequence?: boolean): void;
  reposition(position: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  finish(): void;
  dispose(): void;
}

export interface VegaExecutionOwnershipDriver {
  readonly blockingExecutionId: number | null;
}

export interface VegaCheckpointExecutionDriver extends VegaExecutionDriver {
  captureCheckpoint(): import("@haneoka/vega-protocol").VegaExecutionCheckpoint;
  restoreCheckpoint(checkpoint: import("@haneoka/vega-protocol").VegaExecutionCheckpoint): void;
  forkReplay(checkpoint: import("@haneoka/vega-protocol").VegaExecutionCheckpoint): VegaCheckpointExecutionDriver;
}
