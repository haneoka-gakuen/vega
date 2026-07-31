export type VegaDisposable =
  | { dispose(): void | Promise<void> }
  | { destroy(): void | Promise<void> }
  | { close(): void | Promise<void> }
  | (() => void | Promise<void>);

type Finalizer = () => void | Promise<void>;

const toFinalizer = (value: VegaDisposable): Finalizer => {
  if (typeof value === "function") return value;
  if ("dispose" in value) return () => value.dispose();
  if ("destroy" in value) return () => value.destroy();
  return () => value.close();
};

/**
 * Owns all resources created for an engine, player, scene, or plugin.
 *
 * Finalizers run once in reverse registration order. A scope aborts before
 * disposal starts so async work can stop before GPU/audio resources are freed.
 */
export class VegaLifetime {
  readonly name: string;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  private finalizers: Finalizer[] = [];
  private children = new Set<VegaLifetime>();
  private parent: VegaLifetime | null = null;
  private state: "active" | "disposing" | "disposed" = "active";
  private disposal: Promise<void> | null = null;

  constructor(name: string, parent?: VegaLifetime) {
    this.name = name;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    if (parent) parent.adopt(this);
  }

  get disposed(): boolean {
    return this.state === "disposed";
  }

  get active(): boolean {
    return this.state === "active";
  }

  use<T extends VegaDisposable>(resource: T): T {
    this.assertActive();
    this.finalizers.push(toFinalizer(resource));
    return resource;
  }

  defer(finalizer: Finalizer): () => void {
    this.assertActive();
    this.finalizers.push(finalizer);
    let removed = false;
    return () => {
      if (removed || this.state !== "active") return;
      removed = true;
      const index = this.finalizers.lastIndexOf(finalizer);
      if (index >= 0) this.finalizers.splice(index, 1);
    };
  }

  child(name: string): VegaLifetime {
    this.assertActive();
    return new VegaLifetime(`${this.name}/${name}`, this);
  }

  adopt(child: VegaLifetime): void {
    this.assertActive();
    if (child === this) throw new TypeError("A lifetime cannot adopt itself");
    if (!child.active) throw new ReferenceError(`Lifetime ${child.name} is not active`);
    if (child.parent === this) return;
    if (child.parent) {
      throw new ReferenceError(`Lifetime ${child.name} is already owned by ${child.parent.name}`);
    }
    for (let ancestor: VegaLifetime | null = this; ancestor; ancestor = ancestor.parent) {
      if (ancestor === child) throw new TypeError("A lifetime cannot adopt one of its ancestors");
    }
    child.parent = this;
    this.children.add(child);
    child.defer(() => {
      this.children.delete(child);
      if (child.parent === this) child.parent = null;
    });
  }

  abort(reason: unknown = new DOMException(`Lifetime disposed: ${this.name}`, "AbortError")): void {
    if (!this.signal.aborted) this.controller.abort(reason);
  }

  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.state = "disposing";
    this.abort();
    this.disposal = this.disposeOwned();
    return this.disposal;
  }

  private async disposeOwned(): Promise<void> {
    const errors: unknown[] = [];
    const children = [...this.children].reverse();
    this.children.clear();
    for (const child of children) {
      try {
        await child.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    const finalizers = this.finalizers.reverse();
    this.finalizers = [];
    for (const finalizer of finalizers) {
      try {
        await finalizer();
      } catch (error) {
        errors.push(error);
      }
    }
    this.state = "disposed";
    if (errors.length) throw new AggregateError(errors, `Failed to dispose lifetime ${this.name}`);
  }

  private assertActive(): void {
    if (this.state !== "active") throw new ReferenceError(`Lifetime ${this.name} is ${this.state}`);
  }
}
