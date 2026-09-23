import type { VegaNarrativePosition } from "@haneoka/vega-protocol";
interface IdentifiedCommand {
  readonly commandId?: unknown;
}
export function narrativePositionAtBoundary(
  commands: readonly IdentifiedCommand[],
  boundary: number,
  sceneAt: (index: number) => string,
): VegaNarrativePosition {
  const index = Math.max(0, Math.min(commands.length, Math.trunc(boundary)));
  const before = commands[index],
    after = commands[index - 1];
  if (typeof before?.commandId === "string" && before.commandId)
    return {
      sceneId: sceneAt(index),
      commandIndex: index,
      commandId: before.commandId,
      boundary: "before",
    };
  if (typeof after?.commandId === "string" && after.commandId)
    return {
      sceneId: sceneAt(index - 1),
      commandIndex: index,
      commandId: after.commandId,
      boundary: "after",
    };
  return { sceneId: sceneAt(index), commandIndex: index };
}
export function resolveNarrativePosition(
  commands: readonly IdentifiedCommand[],
  position: VegaNarrativePosition,
  sceneAt: (index: number) => string,
): number {
  if (!position.commandId) return Math.max(0, Math.min(commands.length, position.commandIndex));
  const matches: number[] = [];
  commands.forEach((command, index) => {
    if (command.commandId === position.commandId && sceneAt(index) === position.sceneId) matches.push(index);
  });
  if (matches.length !== 1)
    throw new Error(
      `Saved command is ${matches.length ? "ambiguous" : "missing"}: ${position.sceneId}/${position.commandId}`,
    );
  return matches[0]! + (position.boundary === "after" ? 1 : 0);
}
