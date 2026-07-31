import type { AdvCommand, AdvRuntimeConfig, AdvPlayerState } from "../types/AdvRuntime";
import type { AdvPlaybackSession } from "./AdvPlaybackSession";
import type { AdvPlayerModel } from "./AdvPlayerModel";
import type { AdvEpisodeResourceLoader } from "./AdvEpisodeResourceLoader";
import type { AdvQualityConfig } from "./AdvQualityConfig";
import type { StorySceneBackend } from "../rendering/StorySceneBackend";
import type { AdvSoundManager } from "../sound/AdvSoundManager";

export interface AdvCommandContext {
  Session: AdvPlaybackSession;
  Model: AdvPlayerModel;
  Loader: AdvEpisodeResourceLoader;
  SceneRoot: StorySceneBackend;
  SoundManager: AdvSoundManager;
  QualityConfig: AdvQualityConfig;
  state: AdvPlayerState;
  runtime: AdvRuntimeConfig;
}

export type AdvCommandExecutor = (
  cmd: AdvCommand,
  ctx: AdvCommandContext,
  signal?: AbortSignal,
) => Promise<void> | void;

export class AdvCommandService {
  commands: Map<number, { execute: AdvCommandExecutor }>;

  constructor() {
    this.commands = new Map<number, { execute: AdvCommandExecutor }>();
  }

  registerCommand(commandType: number, command: { execute: AdvCommandExecutor }): () => void {
    const opcode = Number(commandType);
    if (!Number.isSafeInteger(opcode) || opcode < 0) {
      throw new RangeError(`ADV command opcode must be a non-negative safe integer: ${commandType}`);
    }
    if (this.commands.has(opcode)) throw new Error(`ADV command opcode ${opcode} is already registered`);
    this.commands.set(opcode, command);
    return () => {
      if (this.commands.get(opcode) === command) this.commands.delete(opcode);
    };
  }

  executeCommand(
    commandType: number,
    episode: AdvCommand,
    ctx: AdvCommandContext,
    signal?: AbortSignal,
  ): Promise<void> | void {
    const command = this.commands.get(Number(commandType));
    if (!command) {
      ctx.state.unknownCommands = [
        ...(ctx.state.unknownCommands || []),
        { index: episode.index ?? 0, command: episode.command, name: episode.name || "Unknown" },
      ];
      return;
    }
    return command.execute(episode, ctx, signal);
  }
}
