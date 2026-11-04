import { defineVegaPlugin } from "./plugins";
import type { StoryAudioClip } from "../sound/AudioClipPlayer";
import { VEGA_CORE_AUDIO_CLIP, parsePropertyAnimationClip } from "@haneoka/vega-protocol";

export const coreCommandsPlugin = defineVegaPlugin({
  manifest: {
    id: "haneoka.vega-core",
    name: "Vega core commands",
    version: "0.1.0",
    apiVersion: 1,
    capabilities: ["audio", "commands"],
  },
  setup(context) {
    context.registerCommand({
      name: "propertyClip",
      schemaVersion: 1,
      replaySafe: true,
      async execute(command, context, signal) {
        const target = String(command.target ?? "");
        if (!target) throw new TypeError("Property animation target is missing");
        if (command.reset === true) {
          if (!context.SceneRoot.clearScreenTransform) throw new Error("Property animation is unavailable");
          context.SceneRoot.clearScreenTransform(target);
          return;
        }
        const clip = parsePropertyAnimationClip(command.clip);
        if (!context.SceneRoot.playPropertyAnimation) throw new Error("Property animation is unavailable");
        await context.SceneRoot.playPropertyAnimation(target, clip, {
          parallel: command.parallel !== false,
          replaceChannels: true,
          keep: command.keep !== false,
          immediate: context.Model.shouldShortCut,
          signal,
        });
      },
    });
    context.registerCommand({
      name: "audioClip",
      schemaVersion: 1,
      replaySafe: true,
      async execute(command, context, signal) {
        if (context.Model.shouldShortCut) return;
        const clip = command as unknown as StoryAudioClip;
        await context.SoundManager.playAudioClip(clip, signal);
      },
      enumerateCommandResources(command) {
        return command.commandType === VEGA_CORE_AUDIO_CLIP || command.command === VEGA_CORE_AUDIO_CLIP
          ? [{ source: String(command.source), kind: "audio", audioCategory: "Se" }]
          : [];
      },
    });
  },
});
