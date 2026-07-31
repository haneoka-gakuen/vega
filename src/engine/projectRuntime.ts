import { parseVegaProject, type VegaProject } from "@haneoka/vega-protocol";
import { compileVegaProject } from "../narrative/project";
import type { AdvStory } from "../types/AdvRuntime";

export interface VegaProjectBinding {
  readonly story: AdvStory;
  readonly entryKey?: string;
}

const isVegaProject = (value: VegaProject | AdvStory): value is VegaProject =>
  (value as Partial<VegaProject>).format === "vega-project";

/**
 * Compiles every Vega scene into one keyed command stream. Scene calls and
 * replacements therefore retain their runtime semantics in every host.
 */
export const bindVegaProject = (
  project: VegaProject | AdvStory,
  sceneId?: string,
): VegaProjectBinding => {
  if (!isVegaProject(project)) {
    if (
      !project ||
      typeof project !== "object" ||
      (project.commands !== undefined && !Array.isArray(project.commands))
    ) {
      throw new TypeError("Invalid ADV story");
    }
    return { story: project };
  }
  const validated = parseVegaProject(project);
  const compiled = compileVegaProject(validated);
  const selectedSceneId = sceneId ?? validated.entryScene;
  const entryKey = compiled.sceneKeys.get(selectedSceneId);
  if (!entryKey) throw new Error(`Vega project has no scene named ${selectedSceneId}`);
  return {
    story: {
      ...compiled.story,
      vegaEntryKey: entryKey,
      vegaProject: {
        ...(compiled.story.vegaProject as Record<string, unknown>),
        entryScene: selectedSceneId,
      },
    },
    entryKey,
  };
};

export const vegaProjectToAdvStory = (
  project: VegaProject | AdvStory,
  sceneId?: string,
): AdvStory => bindVegaProject(project, sceneId).story;
