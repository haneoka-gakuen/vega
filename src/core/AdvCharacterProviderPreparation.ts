import { prepareCharacterProviderDescriptors, type StoryCharacterProvider } from "../rendering/StoryCharacterModel";
import type { StoryResourceResolver } from "../rendering/StorySceneBackend";
import type { AdvStory } from "../types/AdvRuntime";
import { flattenAdvCommands } from "./AdvCommandTraversal";

/** Prepare provider runtimes from every character descriptor in one story. */
export const prepareStoryCharacterProviders = (
  providers: readonly StoryCharacterProvider[],
  story: AdvStory,
  resources: StoryResourceResolver,
  signal: AbortSignal,
): Promise<void> =>
  prepareCharacterProviderDescriptors(
    providers,
    flattenAdvCommands(story.commands || []).flatMap((command) =>
      command.characterModel ? [command.characterModel] : [],
    ),
    resources,
    signal,
  );
