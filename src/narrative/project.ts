import { VEGA_ADV_OPCODE, VEGA_SYSTEM_OPCODE, type VegaCommand, type VegaProject } from "@haneoka/vega-protocol";
import type { AdvCommand, AdvStory } from "../types/AdvRuntime";

export interface VegaCompiledProject {
  readonly project: VegaProject;
  readonly story: AdvStory;
  readonly entryKey: string;
  readonly sceneKeys: ReadonlyMap<string, string>;
  readonly commandScenes: readonly string[];
}

export interface VegaProjectFlowEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "entry" | "fallthrough" | "jump" | "call" | "branch";
  readonly condition?: string;
}

export interface VegaProjectFlow {
  readonly nodes: readonly string[];
  readonly edges: readonly VegaProjectFlowEdge[];
  readonly unreachable: readonly string[];
}

const SCENE_KEY_PREFIX = "vega:scene:";
const COMMAND_KEY_PREFIX = "vega:command:";

export const vegaSceneKey = (sceneId: string): string => `${SCENE_KEY_PREFIX}${encodeURIComponent(sceneId)}`;

export const compileVegaProject = (project: VegaProject): VegaCompiledProject => {
  const sceneKeys = new Map(Object.keys(project.scenes).map((sceneId) => [sceneId, vegaSceneKey(sceneId)]));
  const commands: AdvCommand[] = [];
  const commandScenes: string[] = [];
  const storyFields = project.metadata?.["altair:storyFields"];
  const portableStory =
    storyFields && typeof storyFields === "object" && !Array.isArray(storyFields)
      ? clonePlain(storyFields as Record<string, unknown>)
      : {};
  delete portableStory.commands;
  delete portableStory.runtime;
  delete portableStory.assets;

  for (const [sceneId, scene] of Object.entries(project.scenes)) {
    const marker: AdvCommand = {
      command: VEGA_SYSTEM_OPCODE.SceneMarker,
      key: sceneKeys.get(sceneId)!,
      sceneId,
      name: "SceneMarker",
    };
    commands.push(marker);
    commandScenes.push(sceneId);

    scene.commands.forEach((source, localIndex) => {
      const command = rewriteProjectCommand(source, sceneId, localIndex, sceneKeys);
      if (Number(source.command) === VEGA_SYSTEM_OPCODE.CallScene) {
        command.currentScene = sceneId;
        command.returnKey = returnKey(sceneId, localIndex);
      }
      commands.push(command);
      commandScenes.push(sceneId);
      if (Number(source.command) === VEGA_SYSTEM_OPCODE.CallScene) {
        commands.push({
          command: VEGA_SYSTEM_OPCODE.SceneMarker,
          key: returnKey(sceneId, localIndex),
          sceneId,
          returnMarker: true,
          name: "SceneReturnMarker",
        });
        commandScenes.push(sceneId);
      }
    });
    const lastOpcode = Number(scene.commands.at(-1)?.command);
    if (
      lastOpcode !== VEGA_SYSTEM_OPCODE.JumpScene &&
      lastOpcode !== VEGA_SYSTEM_OPCODE.ReturnScene &&
      lastOpcode !== VEGA_SYSTEM_OPCODE.End
    ) {
      commands.push({
        command: VEGA_SYSTEM_OPCODE.End,
        sceneId,
        returnIfCalled: true,
        name: "SceneEnd",
      });
      commandScenes.push(sceneId);
    }
  }

  const runtime = project.metadata?.["altair:runtime"];
  const authoringSource = project.metadata?.["altair:authoringSource"];
  const legacyAssets = project.metadata?.["altair:assets"];
  const authoringAssets =
    authoringSource && typeof authoringSource === "object" && !Array.isArray(authoringSource)
      ? (authoringSource as Record<string, unknown>).assets
      : undefined;
  const story: AdvStory = {
    ...portableStory,
    commands,
    ...(runtime && typeof runtime === "object" && !Array.isArray(runtime) ? { runtime: clonePlain(runtime) } : {}),
    ...(authoringAssets && typeof authoringAssets === "object"
      ? { assets: clonePlain(authoringAssets) }
      : legacyAssets && typeof legacyAssets === "object"
        ? { assets: clonePlain(legacyAssets) }
        : {}),
    ...(project.assets ? { vegaAssets: clonePlain(project.assets) } : {}),
    vegaProject: {
      id: project.id,
      title: clonePlain(project.title),
      entryScene: project.entryScene,
      formatVersion: project.formatVersion,
    },
  };
  return {
    project,
    story,
    entryKey: sceneKeys.get(project.entryScene)!,
    sceneKeys,
    commandScenes,
  };
};

export const analyzeVegaProjectFlow = (project: VegaProject): VegaProjectFlow => {
  const nodes = Object.keys(project.scenes);
  const edges: VegaProjectFlowEdge[] = [];
  const nodeSet = new Set(nodes);
  edges.push({ from: "$entry", to: project.entryScene, kind: "entry" });

  for (const [sceneId, scene] of Object.entries(project.scenes)) {
    for (const command of scene.commands) {
      const opcode = Number(command.command);
      if (opcode === VEGA_SYSTEM_OPCODE.JumpScene || opcode === VEGA_SYSTEM_OPCODE.CallScene) {
        const target = commandString(command, "sceneId");
        if (target) {
          edges.push({ from: sceneId, to: target, kind: opcode === VEGA_SYSTEM_OPCODE.JumpScene ? "jump" : "call" });
        }
      } else if (opcode === VEGA_SYSTEM_OPCODE.Branch) {
        const thenScene = commandString(command, "thenScene");
        const elseScene = commandString(command, "elseScene");
        const condition = commandString(command, "condition");
        if (thenScene)
          edges.push({ from: sceneId, to: thenScene, kind: "branch", ...(condition ? { condition } : {}) });
        if (elseScene) {
          edges.push({
            from: sceneId,
            to: elseScene,
            kind: "branch",
            ...(condition ? { condition: `!(${condition})` } : {}),
          });
        }
      }
    }
  }

  const visited = new Set<string>();
  const queue = [project.entryScene];
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current) || !nodeSet.has(current)) continue;
    visited.add(current);
    for (const edge of edges) if (edge.from === current && !visited.has(edge.to)) queue.push(edge.to);
  }
  return { nodes, edges, unreachable: nodes.filter((node) => !visited.has(node)) };
};

const rewriteProjectCommand = (
  source: VegaCommand,
  sceneId: string,
  localIndex: number,
  sceneKeys: ReadonlyMap<string, string>,
): AdvCommand => {
  const command = clonePlain(source) as unknown as AdvCommand;
  const opcode = Number(source.command);
  command.index = localIndex;
  command.sceneSource = sceneId;
  if (opcode !== VEGA_SYSTEM_OPCODE.JumpScene && opcode !== VEGA_SYSTEM_OPCODE.CallScene) {
    command.sceneId = sceneId;
  }
  command.sceneCommandIndex = localIndex;
  if (source.key) command.key = localCommandKey(sceneId, source.key);

  if (opcode === VEGA_ADV_OPCODE.GoTo && Array.isArray(source.params) && source.params[0]) {
    command.params = [localCommandKey(sceneId, String(source.params[0])), ...source.params.slice(1).map(String)];
  }
  if (Array.isArray(command.choices)) {
    command.choices = command.choices.map((choice) => ({
      ...choice,
      nextKey: resolveTargetKey(String(choice.nextKey || ""), sceneId, sceneKeys),
    }));
  }
  for (const field of ["targetKey", "thenKey", "elseKey"] as const) {
    const value = source[field];
    if (typeof value === "string" && value) command[field] = resolveTargetKey(value, sceneId, sceneKeys);
  }
  for (const field of ["sceneId", "thenScene", "elseScene"] as const) {
    const value = source[field];
    if (typeof value === "string" && value && !sceneKeys.has(value)) {
      throw new RangeError(`Scene ${sceneId} command ${localIndex} references missing scene ${value}`);
    }
  }
  return command;
};

const resolveTargetKey = (value: string, sceneId: string, sceneKeys: ReadonlyMap<string, string>): string => {
  if (sceneKeys.has(value)) return sceneKeys.get(value)!;
  if (value.startsWith(SCENE_KEY_PREFIX) || value.startsWith(COMMAND_KEY_PREFIX)) return value;
  return localCommandKey(sceneId, value);
};

const localCommandKey = (sceneId: string, key: string): string =>
  `${COMMAND_KEY_PREFIX}${encodeURIComponent(sceneId)}:${encodeURIComponent(key)}`;

const returnKey = (sceneId: string, commandIndex: number): string =>
  `vega:return:${encodeURIComponent(sceneId)}:${commandIndex}`;

const commandString = (command: VegaCommand, field: string): string => {
  const value = command[field];
  return typeof value === "string" ? value : "";
};

const clonePlain = <T>(value: T): T => {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
};
