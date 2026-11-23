import { defineVegaPlugin } from "./plugins";
import type { StoryAudioClip } from "../sound/AudioClipPlayer";
import {
  VEGA_CORE_ADJUSTMENT,
  VEGA_CORE_AUDIO_CLIP,
  VEGA_CORE_MEDIA_CLIP,
  parsePropertyAnimationClip,
  parseVegaBackdropAdjustment,
  parseStageClipGainAnimation,
  parseVegaStageAdjustment,
  parseVegaStageComposition,
  parseVegaStageMediaClip,
  stageMediaAudioClip,
} from "@haneoka/vega-protocol";

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
      name: "composition",
      schemaVersion: 1,
      replaySafe: true,
      async execute(command, context, signal) {
        if (context.Model.shouldShortCut || signal?.aborted) return;
        const { clip, ...options } = parseVegaStageComposition(command);
        const createRaster = context.createTimelineRaster?.(command, options);
        const id = String(command.commandId ?? command.key ?? "");
        if (!createRaster) throw new Error("Timeline compositions are unavailable in this host");
        const end = await context.SceneRoot.beginStageMediaClip?.(id, clip, signal, createRaster);
        if (!end) throw new Error("Timeline compositions are unavailable in this renderer");
        try {
          await context.waitTimelineSeconds(clip.durationSeconds, signal);
        } finally {
          end();
        }
      },
    });
    context.registerCommand({
      name: "mediaClip",
      schemaVersion: 1,
      replaySafe: true,
      async execute(command, context, signal) {
        if (context.Model.shouldShortCut || signal?.aborted) return;
        const clip = parseVegaStageMediaClip(command);
        const id = String(command.commandId ?? command.key ?? "");
        const sound =
          clip.mediaKind === "video" && clip.audioEnabled && clip.volume > 0
            ? stageMediaAudioClip(clip, `${id}/audio`, id)
            : undefined;
        if (sound) await context.SoundManager.prepareAudioClip(sound);
        if (signal?.aborted) return;
        const end = await context.SceneRoot.beginStageMediaClip?.(id, clip, signal);
        if (!end) throw new Error("Media layers are unavailable in this renderer");
        try {
          await Promise.all([
            context.waitTimelineSeconds(clip.durationSeconds, signal),
            ...(sound ? [context.SoundManager.playAudioClip(sound, signal)] : []),
          ]);
        } finally {
          end();
        }
      },
      enumerateCommandResources(command) {
        return (command.commandType === VEGA_CORE_MEDIA_CLIP || command.command === VEGA_CORE_MEDIA_CLIP) &&
          typeof command.source === "string"
          ? [
              {
                source: command.source,
                kind: command.mediaKind === "video" ? "video" : "texture",
              },
            ]
          : [];
      },
    });
    context.registerCommand({
      name: "adjustment",
      schemaVersion: 1,
      replaySafe: true,
      async execute(command, context, signal) {
        if (context.Model.shouldShortCut || signal?.aborted) return;
        const adjustment =
          command.scope === "below" ? parseVegaBackdropAdjustment(command) : parseVegaStageAdjustment(command);
        const end =
          "backdrop" in adjustment
            ? await context.SceneRoot.beginStageMediaClip?.(
                String(command.commandId ?? command.key ?? ""),
                adjustment,
                signal,
              )
            : await context.SceneRoot.beginStageAdjustment?.(adjustment, signal);
        if (!end) throw new Error("Stage adjustments are unavailable in this renderer");
        try {
          await context.waitTimelineSeconds(adjustment.durationSeconds, signal);
        } finally {
          end();
        }
      },
      enumerateCommandResources(command) {
        return (command.commandType === VEGA_CORE_ADJUSTMENT || command.command === VEGA_CORE_ADJUSTMENT) &&
          typeof command.source === "string"
          ? [{ source: command.source, kind: "texture" }]
          : [];
      },
    });
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
        parseStageClipGainAnimation(clip.gainAnimation);
        const target =
          clip.category === "Voice" && typeof clip.lipSyncTarget === "string" ? clip.lipSyncTarget.trim() : undefined;
        await context.SoundManager.playAudioClip(
          clip,
          signal,
          target
            ? (source, duration) => {
                context.SceneRoot.startVoiceLipSync(target, [source], duration);
              }
            : undefined,
        );
      },
      enumerateCommandResources(command) {
        return command.commandType === VEGA_CORE_AUDIO_CLIP || command.command === VEGA_CORE_AUDIO_CLIP
          ? [
              {
                source: String(command.source),
                kind: command.sourceKind === "video" ? "video" : "audio",
                audioCategory: "Se",
              },
            ]
          : [];
      },
    });
  },
});
