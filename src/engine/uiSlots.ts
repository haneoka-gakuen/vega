export const VEGA_STANDARD_UI_SLOTS = ["before-stage", "stage-overlay", "dialogue", "controls", "after-stage"] as const;
export type VegaStandardUiSlot = (typeof VEGA_STANDARD_UI_SLOTS)[number];
