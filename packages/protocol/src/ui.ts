export type VegaUiAction =
  | { readonly type: "advance" | "pause" | "resume" | "skip" }
  | { readonly type: "choose"; readonly key: unknown };

export interface VegaUiActionPort {
  readonly supportedActions: readonly VegaUiAction["type"][];
  dispatch(action: VegaUiAction): void | Promise<void>;
}
