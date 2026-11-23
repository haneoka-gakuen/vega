import type { AdvCommand, AdvCommandGroup, AdvCommandGroupAction } from "../types/AdvRuntime";

const finiteSeconds = (value: unknown): number => {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
};

const isCommand = (value: unknown): value is AdvCommand =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Read and normalize the canonical command-group payload. */
export function resolveAdvCommandGroup(value: unknown): AdvCommandGroup | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Partial<AdvCommandGroup>;
  const actions = Array.isArray(source.actions)
    ? source.actions.flatMap((action): AdvCommandGroupAction[] => {
        if (
          !action ||
          typeof action !== "object" ||
          (action.role !== "lifetime" && action.role !== "event") ||
          !isCommand(action.command)
        ) {
          return [];
        }
        const anchor = action.anchor;
        return [
          {
            atSeconds: finiteSeconds(action.atSeconds),
            role: action.role,
            command: action.command,
            ...(action.suppressed === true ? { suppressed: true } : {}),
            ...(typeof action.cueId === "string" && action.cueId ? { cueId: action.cueId } : {}),
            ...(finiteSeconds(action.minimumEndSeconds) > 0
              ? { minimumEndSeconds: finiteSeconds(action.minimumEndSeconds) }
              : {}),
            ...(anchor && typeof anchor.nodeId === "string" && (anchor.point === "start" || anchor.point === "end")
              ? { anchor: { ...anchor, offsetSeconds: finiteSeconds(anchor.offsetSeconds) } }
              : {}),
          },
        ];
      })
    : [];
  return {
    waitForPrevious: source.waitForPrevious === true,
    ...(source.waitForCompletion === true ? { waitForCompletion: true } : {}),
    cancelOnManualAdvance: source.cancelOnManualAdvance === true,
    durationSeconds: finiteSeconds(source.durationSeconds),
    actions,
  };
}

/** Stable chronological order used by runtime execution and deterministic replay. */
export function sortAdvCommandGroupActions(actions: readonly AdvCommandGroupAction[]): AdvCommandGroupAction[] {
  const ordered = actions
    .map((action, index) => ({ action, index }))
    .sort((left, right) => left.action.atSeconds - right.action.atSeconds || left.index - right.index)
    .map(({ action }) => action);
  if (!ordered.some((action) => action.anchor)) return ordered;
  const byCue = new Map<string, AdvCommandGroupAction[]>();
  for (const action of ordered) {
    if (action.cueId) byCue.set(action.cueId, [...(byCue.get(action.cueId) ?? []), action]);
  }
  const visited = new Set<AdvCommandGroupAction>();
  const result: AdvCommandGroupAction[] = [];
  const visit = (action: AdvCommandGroupAction) => {
    if (visited.has(action)) return;
    visited.add(action);
    if (action.anchor) byCue.get(action.anchor.nodeId)?.forEach(visit);
    result.push(action);
  };
  ordered.forEach(visit);
  return result;
}

/** Nested commands exposed to preload, hydration, and text-mode traversal. */
export function advCommandGroupCommands(command: AdvCommand): AdvCommand[] {
  const group = resolveAdvCommandGroup(command.commandGroup);
  return group
    ? sortAdvCommandGroupActions(group.actions)
        .filter((action) => !action.suppressed)
        .map((action) => action.command)
    : [];
}
