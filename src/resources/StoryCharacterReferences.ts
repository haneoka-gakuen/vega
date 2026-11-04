import type { AdvCharacterModelEntry, AdvCommand, AdvStory } from "../types/AdvRuntime";

export const STORY_CHARACTER_MODELS_KEY = "vega:characterModels";

/** Expand immutable model definitions once at the player boundary. */
export function resolveStoryCharacterModels(story: AdvStory): AdvStory {
  const models = story.characterModels;
  const bind = (command: AdvCommand): AdvCommand => {
    const result = { ...command };
    if (command.characterModelRef !== undefined) {
      const model = models?.[command.characterModelRef];
      if (!model || typeof model !== "object" || Array.isArray(model))
        throw new TypeError(`Missing character model definition: ${command.characterModelRef}`);
      if (command.characterModel) throw new TypeError("Character model reference has an inline definition");
      result.characterModel = model as AdvCharacterModelEntry;
      delete result.characterModelRef;
    }
    if (command.commandGroup)
      result.commandGroup = {
        ...command.commandGroup,
        actions: command.commandGroup.actions.map((action) => ({ ...action, command: bind(action.command) })),
      };
    if (command.timeline)
      result.timeline = {
        ...command.timeline,
        signals: command.timeline.signals.map((signal) => ({ ...signal, episode: bind(signal.episode) })),
      };
    return result;
  };
  return { ...story, commands: story.commands?.map(bind) };
}
