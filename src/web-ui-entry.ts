export type { VegaUiAction, VegaUiActionPort } from "@haneoka/vega-protocol";
export { createVegaWebUiActions } from "./hosts/web/uiSlots";
export type {
  VegaWebUiSlotContext,
  VegaWebUiSlotContribution,
  VegaWebUiSlotContext as VegaUiSlotContext,
  VegaWebUiSlotContribution as VegaUiSlotContribution,
} from "./hosts/web/uiSlots";
