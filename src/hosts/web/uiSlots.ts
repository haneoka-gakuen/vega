import type { VegaUiAction, VegaUiActionPort } from "@haneoka/vega-protocol";
import type { AdvPlayer } from "../../core/AdvPlayer";
import type { AdvPlayerState } from "../../types/AdvRuntime";
import type { VegaUiSlotContribution, VegaUiSlotContext } from "../../engine/plugins";

export interface VegaWebUiSlotContext extends VegaUiSlotContext<AdvPlayerState> {
  readonly player: AdvPlayer;
  readonly root: HTMLElement;
}

export type VegaWebUiSlotContribution = VegaUiSlotContribution<HTMLElement, VegaWebUiSlotContext> & {
  readonly hostKind?: "web";
};

export const createVegaWebUiActions = (player: AdvPlayer): VegaUiActionPort =>
  Object.freeze({
    supportedActions: Object.freeze(["advance", "choose", "pause", "resume", "skip"] as const),
    dispatch(action: VegaUiAction) {
      switch (action.type) {
        case "advance":
          return player.requestNext();
        case "choose":
          return player.choose(action.key);
        case "pause":
          return player.pause();
        case "resume":
          return player.resume();
        case "skip":
          return player.skip();
      }
    },
  });
