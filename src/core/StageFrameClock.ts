interface ScheduledCallback {
  readonly time: number;
  readonly callback: () => void;
}

/** One authored clock for a frame export. Resource I/O can suspend its advance. */
export class StageFrameClock {
  private time = 0;
  private nextId = -1;
  private readonly callbacks = new Map<number, ScheduledCallback>();
  private readonly resources = new Set<Promise<unknown>>();
  private readonly channel = new MessageChannel();
  private readonly aborted: Promise<void>;
  private flushResolve?: () => void;
  private released = false;
  private failure?: { error: unknown };

  constructor(readonly signal: AbortSignal) {
    this.channel.port1.onmessage = () => this.flushResolve?.();
    this.aborted = signal.aborted
      ? Promise.resolve()
      : new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
  }

  nowSeconds(): number {
    return this.time;
  }

  schedule(seconds: number, callback: () => void): number {
    this.signal.throwIfAborted();
    const id = this.nextId--;
    this.callbacks.set(id, { time: this.time + Math.max(0, seconds), callback });
    return id;
  }

  readonly scheduleDelay = (seconds: number, callback: () => void): (() => void) => {
    const id = this.schedule(seconds, callback);
    return () => this.cancel(id);
  };

  cancel(id: number): void {
    this.callbacks.delete(id);
  }

  hold<T>(operation: Promise<T>): Promise<T> {
    this.resources.add(operation);
    const settled = () => this.resources.delete(operation);
    void operation.then(settled, (error: unknown) => {
      settled();
      if (!(error instanceof Error && error.name === "AbortError")) this.failure ??= { error };
    });
    return operation;
  }

  async settle(): Promise<void> {
    do {
      this.signal.throwIfAborted();
      await new Promise<void>((resolve) => {
        this.flushResolve = resolve;
        this.channel.port2.postMessage(null);
      });
      this.flushResolve = undefined;
      if (this.failure) throw this.failure.error;
      if (!this.resources.size) return;
      await Promise.race([Promise.allSettled(this.resources), this.aborted]);
    } while (true);
  }

  async advanceTo(time: number): Promise<void> {
    if (!Number.isFinite(time) || time < this.time) throw new RangeError("Invalid export time");
    await this.settle();
    for (;;) {
      this.signal.throwIfAborted();
      let next = Infinity;
      for (const callback of this.callbacks.values()) if (callback.time < next) next = callback.time;
      if (next > time + 1e-10) break;
      this.time = Math.max(this.time, Math.min(next, time));
      for (const [id, callback] of [...this.callbacks]) {
        if (callback.time !== next || !this.callbacks.delete(id)) continue;
        callback.callback();
      }
      await this.settle();
    }
    this.time = time;
  }

  close(): void {
    if (this.released) return;
    this.released = true;
    this.callbacks.clear();
    this.resources.clear();
    this.flushResolve?.();
    this.channel.port1.close();
    this.channel.port2.close();
  }
}
