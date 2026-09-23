import type { StoryRendererServiceKey } from "./StoryRendererExtensions";
export interface StoryFilterSurface {
  readonly width: number;
  readonly height: number;
}
export interface StoryFilterImage {
  readonly source: object;
  readonly width: number;
  readonly height: number;
  readonly revision: number;
  readonly nearest?: boolean;
  readonly mipmap?: boolean;
}
export interface StoryFilterPass {
  readonly program: object;
  readonly vertex: string;
  readonly fragment: string;
  readonly legacy: boolean;
  readonly blend: boolean;
  readonly uniforms: Readonly<Record<string, unknown>>;
}
export interface StoryFilterContext {
  readonly input: StoryFilterSurface;
  readonly output: StoryFilterSurface;
  readonly resolution: number;
  readonly x: number;
  readonly y: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  acquire(): StoryFilterSurface;
  release(surface: StoryFilterSurface): void;
  draw(pass: StoryFilterPass, input: StoryFilterSurface, output: StoryFilterSurface): void;
}
export interface StoryScreenFilterController {
  readonly active: boolean;
  readonly padding: number;
  configure(values: Readonly<Record<string, number>>): void;
  render(context: StoryFilterContext): void;
  snapshot(): unknown;
  restore(value: unknown): void;
  dispose(): void;
}
export interface StoryScreenFilterProvider {
  readonly channels: readonly string[];
  create(target: string): StoryScreenFilterController;
}
export const STORY_SCREEN_FILTER_PROVIDER: StoryRendererServiceKey<StoryScreenFilterProvider> = Object.freeze({
  id: "vega.screen-filter-provider",
});
