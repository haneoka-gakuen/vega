import { VEGA_ADV_OPCODE, VEGA_COMMAND_GROUP_OPCODE } from "@haneoka/vega-protocol";
import { AdvPlayer } from "../../core/AdvPlayer";
import type { AdvCommandContext } from "../../core/AdvCommandService";
import { StageTimelineSampler } from "../../engine/StageTimelineSampler";
import type { VegaEngine, VegaPlayerOptions } from "../../engine/VegaEngine";
import type { StoryResourceResolver } from "../../resources/StoryResourcePort";

/** Browser-host implementation of the portable stage raster port. */
export function createWebTimelineRaster(
  engine: VegaEngine,
  options: VegaPlayerOptions,
  resources: StoryResourceResolver,
  document: Document,
): NonNullable<AdvCommandContext["createTimelineRaster"]> {
  return (command, { aspectRatio, transparentBackground, includeDialogue, sourceLoop }) =>
    async (viewport, signal) => {
      const group = command.commandGroup;
      if (!group) throw new TypeError("A timeline composition requires a command group");
      signal.throwIfAborted();
      const width = Math.max(2, Math.round(Math.min(viewport.width, viewport.height * aspectRatio)));
      const height = Math.max(2, Math.min(viewport.height, Math.round(width / aspectRatio)));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The composition canvas is unavailable");
      const declarations = (options.story.commands ?? []).filter((item) => item.command === VEGA_ADV_OPCODE.Character);
      const composition = { command: VEGA_COMMAND_GROUP_OPCODE, commandGroup: group };
      const { vegaEntryKey: _entry, ...source } = options.story;
      const createSampler = async () => {
        signal.throwIfAborted();
        const mount = document.createElement("div");
        mount.setAttribute("aria-hidden", "true");
        Object.assign(mount.style, {
          position: "fixed",
          left: "-200vw",
          top: "0",
          width: `${width}px`,
          height: `${height}px`,
          pointerEvents: "none",
        });
        document.body.append(mount);
        let dispose: (() => Promise<void>) | undefined;
        try {
          const handle = await engine.createPlayer({
            surface: mount,
            resources,
            story: { ...source, commands: [...declarations, composition] },
            externalPlaybackControls: true,
            ...(options.theme === undefined ? {} : { theme: options.theme }),
            ...(options.renderBackend === undefined ? {} : { renderBackend: options.renderBackend }),
            ...(options.resolveLocalizedText === undefined
              ? {}
              : { resolveLocalizedText: options.resolveLocalizedText }),
          });
          dispose = () => handle.dispose();
          const player = handle.player;
          if (!(player instanceof AdvPlayer)) throw new Error("The web host did not create an ADV composition player");
          const sampler = new StageTimelineSampler({ player, dispose: () => handle.dispose() }, mount);
          dispose = () => sampler.dispose();
          signal.throwIfAborted();
          handle.shell?.enterGame();
          if (declarations.length) await player.replayFromStartTo(declarations.length);
          signal.throwIfAborted();
          sampler.start(player.story.commands![declarations.length]!, width, height, transparentBackground);
          return sampler;
        } catch (error) {
          try {
            await dispose?.();
          } finally {
            mount.remove();
          }
          throw error;
        }
      };
      let sampler = await createSampler();
      let time = -1;
      let cycle = 0;
      let sample: Promise<boolean> | undefined;
      return {
        canvas,
        subtitleText: () => (includeDialogue ? sampler.subtitleText : ""),
        sample(seconds) {
          const capture = async () => {
            signal.throwIfAborted();
            if (seconds <= time) return false;
            let position = seconds;
            if (sourceLoop) {
              const length = sourceLoop.end - sourceLoop.start;
              const offset = seconds - sourceLoop.start;
              const nextCycle = Math.floor((offset + 1e-9) / length);
              position = sourceLoop.start + Math.max(0, offset - nextCycle * length);
              if (cycle !== nextCycle) {
                await sampler.dispose();
                sampler = await createSampler();
                cycle = nextCycle;
              }
            }
            const frame = await sampler.captureAt(position, signal, includeDialogue);
            context.clearRect(0, 0, width, height);
            context.drawImage(frame, 0, 0);
            time = seconds;
            return true;
          };
          sample = capture();
          return sample;
        },
        async dispose() {
          try {
            await sample;
          } catch {
            // The sampling caller receives the error.
          } finally {
            await sampler.dispose();
          }
        },
      };
    };
}
