import {
  assertVegaPluginLock,
  type VegaPluginLock,
  type VegaPluginLockEntry,
  type VegaPluginLockTarget,
  type VegaPluginMarketplaceEntry,
  type VegaProjectPlugin,
} from "@haneoka/vega-protocol";
import {
  isVegaPluginTargetCompatible,
  normalizeVegaPluginCatalog,
  vegaPluginSourceKey,
} from "./catalog";
import {
  compareVegaSemVer,
  isValidVegaSemVerRange,
  parseVegaSemVer,
  satisfiesVegaSemVer,
} from "./semver";

export type VegaPluginResolutionDiagnosticCode =
  | "plugin-not-found"
  | "invalid-version"
  | "version-conflict"
  | "source-mismatch"
  | "target-incompatible"
  | "capability-missing"
  | "dependency-cycle"
  | "permission-denied"
  | "permission-review-required"
  | "optional-plugin-skipped";

export interface VegaPluginResolutionDiagnostic {
  readonly code: VegaPluginResolutionDiagnosticCode;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly pluginId?: string;
  readonly relatedPluginId?: string;
  readonly ranges?: readonly string[];
  readonly permissions?: readonly string[];
  readonly cycle?: readonly string[];
}

export interface VegaPluginResolutionRequest {
  readonly plugins: readonly VegaProjectPlugin[];
  readonly target?: VegaPluginLockTarget;
  /** Permissions granted independently of per-project plugin declarations. */
  readonly grantedPermissions?: readonly string[];
  /** An explicit deny always wins over a grant. */
  readonly deniedPermissions?: readonly string[];
  /** Defaults to true. */
  readonly includeOptionalDependencies?: boolean;
}

export interface VegaPluginResolutionResult {
  readonly ok: boolean;
  readonly entries: readonly VegaPluginMarketplaceEntry[];
  readonly lock: VegaPluginLock | null;
  readonly diagnostics: readonly VegaPluginResolutionDiagnostic[];
}

interface Constraint {
  readonly range: string;
  readonly from: string;
}

interface SolverState {
  readonly selected: Map<string, VegaPluginMarketplaceEntry>;
  readonly constraints: Map<string, Constraint[]>;
}

interface SolveFailure {
  readonly id: string;
  readonly reason:
    | "missing"
    | "invalid-range"
    | "invalid-version"
    | "version"
    | "source"
    | "target"
    | "capability";
  readonly constraints: readonly Constraint[];
}

type SolveResult =
  | { readonly ok: true; readonly state: SolverState }
  | { readonly ok: false; readonly failure: SolveFailure };

export class VegaPluginDependencyResolver {
  private readonly catalog: readonly VegaPluginMarketplaceEntry[];

  constructor(entries: readonly VegaPluginMarketplaceEntry[]) {
    this.catalog = normalizeVegaPluginCatalog(entries);
  }

  resolve(request: VegaPluginResolutionRequest): VegaPluginResolutionResult {
    return resolveVegaPluginDependencies(this.catalog, request);
  }
}

export const resolveVegaPluginDependencies = (
  catalog: readonly VegaPluginMarketplaceEntry[],
  request: VegaPluginResolutionRequest,
): VegaPluginResolutionResult => {
  const normalizedCatalog = normalizeVegaPluginCatalog(catalog);
  const diagnostics: VegaPluginResolutionDiagnostic[] = [];
  const requests = [...request.plugins].sort((left, right) =>
    compareStableText(left.id, right.id),
  );
  const requestById = new Map<string, VegaProjectPlugin>();
  for (const plugin of requests) {
    if (requestById.has(plugin.id)) {
      diagnostics.push({
        code: "version-conflict",
        severity: "error",
        pluginId: plugin.id,
        ranges: requests
          .filter(({ id }) => id === plugin.id)
          .map(({ version }) => version),
        message: `Project declares plugin ${plugin.id} more than once`,
      });
      continue;
    }
    requestById.set(plugin.id, plugin);
    if (!isValidVegaSemVerRange(plugin.version)) {
      diagnostics.push({
        code: "invalid-version",
        severity: plugin.required === false ? "warning" : "error",
        pluginId: plugin.id,
        ranges: [plugin.version],
        message: `Plugin ${plugin.id} uses invalid semantic-version range ${plugin.version}`,
      });
    }
    if (!isVegaPluginTargetCompatible(plugin.targets, request.target)) {
      diagnostics.push({
        code: "target-incompatible",
        severity: plugin.required === false ? "warning" : "error",
        pluginId: plugin.id,
        message: `Project plugin ${plugin.id} does not support the requested target`,
      });
    }
  }

  if (diagnostics.some(({ severity }) => severity === "error")) {
    return failureResult(diagnostics);
  }

  let state: SolverState = { selected: new Map(), constraints: new Map() };
  for (const plugin of requests.filter(({ required }) => required !== false)) {
    state = addConstraint(state, plugin.id, plugin.version, "project");
  }
  let solved = solve(normalizedCatalog, state, request.target, requestById);
  if (!solved.ok) {
    diagnostics.push(failureDiagnostic(solved.failure, false));
    return failureResult(diagnostics);
  }
  state = solved.state;

  for (const plugin of requests.filter(({ required }) => required === false)) {
    if (
      !isValidVegaSemVerRange(plugin.version) ||
      !isVegaPluginTargetCompatible(plugin.targets, request.target)
    ) {
      continue;
    }
    const candidateState = addConstraint(
      cloneState(state),
      plugin.id,
      plugin.version,
      "project (optional)",
    );
    solved = solve(normalizedCatalog, candidateState, request.target, requestById);
    if (solved.ok) {
      state = solved.state;
    } else {
      diagnostics.push(failureDiagnostic(solved.failure, true));
    }
  }

  if (request.includeOptionalDependencies !== false) {
    const attempted = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      const optional = [...state.selected.values()]
        .flatMap((entry) =>
          Object.entries(entry.optionalDependencies ?? {}).map(([id, range]) => ({
            owner: entry.id,
            id,
            range,
          })),
        )
        .sort((left, right) =>
          compareStableText(
            `${left.owner}\0${left.id}`,
            `${right.owner}\0${right.id}`,
          ),
        );
      for (const dependency of optional) {
        const attemptKey = `${dependency.owner}\0${dependency.id}\0${dependency.range}`;
        if (attempted.has(attemptKey)) continue;
        attempted.add(attemptKey);
        const candidateState = addConstraint(
          cloneState(state),
          dependency.id,
          dependency.range,
          `${dependency.owner} (optional)`,
        );
        const optionalResult = solve(
          normalizedCatalog,
          candidateState,
          request.target,
          requestById,
        );
        if (optionalResult.ok) {
          if (optionalResult.state.selected.size > state.selected.size) changed = true;
          state = optionalResult.state;
        } else {
          diagnostics.push(failureDiagnostic(optionalResult.failure, true));
        }
      }
    }
  }

  const selectedEntries = sortEntries([...state.selected.values()]);
  const projectDependencies = Object.fromEntries(
    [...requestById]
      .filter(([, plugin]) => plugin.dependencies !== undefined)
      .map(([id, plugin]) => [id, plugin.dependencies!]),
  );
  const cycles = dependencyCycles(selectedEntries, projectDependencies);
  for (const cycle of cycles) {
    diagnostics.push({
      code: "dependency-cycle",
      severity: "error",
      pluginId: cycle[0],
      cycle,
      message: `Plugin dependency cycle: ${cycle.join(" -> ")}`,
    });
  }

  for (const entry of selectedEntries) {
    const projectRequest = requestById.get(entry.id);
    const expectedCapabilities = projectRequest?.capabilities ?? [];
    const missingCapabilities = expectedCapabilities.filter(
      (capability) => !entry.capabilities?.includes(capability),
    );
    if (missingCapabilities.length) {
      diagnostics.push({
        code: "capability-missing",
        severity: "error",
        pluginId: entry.id,
        message: `Plugin ${entry.id} is missing required capabilities: ${missingCapabilities.join(", ")}`,
      });
    }
  }

  diagnosePermissions(selectedEntries, request, requestById, diagnostics);
  const hasErrors = diagnostics.some(({ severity }) => severity === "error");
  const lock = hasErrors
    ? null
    : createVegaPluginLock(
        selectedEntries,
        request.target,
        projectDependencies,
      );
  return Object.freeze({
    ok: !hasErrors,
    entries: Object.freeze(selectedEntries),
    lock,
    diagnostics: Object.freeze(diagnostics),
  });
};

export const createVegaPluginLock = (
  entries: readonly VegaPluginMarketplaceEntry[],
  target?: VegaPluginLockTarget,
  additionalDependencies: Readonly<
    Record<string, Readonly<Record<string, string>>>
  > = {},
): VegaPluginLock => {
  const sorted = sortEntries([...entries]);
  const selected = new Map(sorted.map((entry) => [entry.id, entry]));
  const plugins: VegaPluginLockEntry[] = sorted
    .map((entry) => {
      const dependencies = Object.fromEntries(
        [
          ...Object.keys(entry.dependencies ?? {}),
          ...Object.keys(entry.optionalDependencies ?? {}).filter((id) =>
            selected.has(id),
          ),
          ...Object.keys(additionalDependencies[entry.id] ?? {}),
        ]
          .filter((id, index, values) => values.indexOf(id) === index)
          .sort(compareStableText)
          .map((id) => [id, selected.get(id)?.version])
          .filter((pair): pair is [string, string] => pair[1] !== undefined),
      );
      return Object.freeze({
        id: entry.id,
        version: entry.version,
        source: cloneSource(entry.source),
        ...(entry.integrity !== undefined ? { integrity: entry.integrity } : {}),
        dependencies: Object.freeze(dependencies),
        ...(entry.capabilities?.length
          ? { capabilities: sortedUnique(entry.capabilities) }
          : {}),
        ...(entry.permissions?.length
          ? { permissions: sortedUnique(entry.permissions) }
          : {}),
        ...(entry.externalRuntimes?.length
          ? {
              externalRuntimes: Object.freeze(
                entry.externalRuntimes.map((runtime) =>
                  Object.freeze({
                    ...runtime,
                    provisioning: Object.freeze([...runtime.provisioning]),
                  }),
                ),
              ),
            }
          : {}),
      });
    })
    .sort((left, right) => compareStableText(left.id, right.id));
  const lock: VegaPluginLock = Object.freeze({
    format: "vega-plugin-lock",
    formatVersion: 1,
    projectFormatVersion: 1,
    ...(target ? { target: cloneTarget(target) } : {}),
    plugins: Object.freeze(plugins),
  });
  assertVegaPluginLock(lock);
  return lock;
};

const solve = (
  catalog: readonly VegaPluginMarketplaceEntry[],
  initial: SolverState,
  target: VegaPluginLockTarget | undefined,
  requests: ReadonlyMap<string, VegaProjectPlugin>,
): SolveResult => {
  const invalidSelected = [...initial.selected.entries()].find(([id, entry]) =>
    !(initial.constraints.get(id) ?? []).every(({ range }) =>
      satisfiesVegaSemVer(entry.version, range),
    ),
  );
  if (invalidSelected) {
    return {
      ok: false,
      failure: {
        id: invalidSelected[0],
        reason: "version",
        constraints: initial.constraints.get(invalidSelected[0]) ?? [],
      },
    };
  }

  const unresolved = [...initial.constraints.keys()].filter(
    (id) => !initial.selected.has(id),
  );
  if (!unresolved.length) return { ok: true, state: initial };

  const choices = unresolved
    .map((id) => ({
      id,
      candidates: candidatesFor(
        catalog,
        id,
        initial.constraints.get(id) ?? [],
        target,
        requests.get(id),
      ),
    }))
    .sort(
      (left, right) =>
        left.candidates.entries.length - right.candidates.entries.length ||
        compareStableText(left.id, right.id),
    );
  const choice = choices[0]!;
  if (!choice.candidates.entries.length) {
    return {
      ok: false,
      failure: {
        id: choice.id,
        reason: choice.candidates.reason,
        constraints: initial.constraints.get(choice.id) ?? [],
      },
    };
  }

  let firstFailure: SolveFailure | undefined;
  for (const entry of choice.candidates.entries) {
    let next = cloneState(initial);
    next.selected.set(choice.id, entry);
    for (const [dependency, range] of Object.entries(entry.dependencies ?? {})) {
      next = addConstraint(next, dependency, range, entry.id);
    }
    const projectDependencies = requests.get(choice.id)?.dependencies ?? {};
    for (const [dependency, range] of Object.entries(projectDependencies)) {
      next = addConstraint(next, dependency, range, `project:${choice.id}`);
    }
    const result = solve(catalog, next, target, requests);
    if (result.ok) return result;
    firstFailure ??= result.failure;
  }
  return {
    ok: false,
    failure:
      firstFailure ?? {
        id: choice.id,
        reason: "version",
        constraints: initial.constraints.get(choice.id) ?? [],
      },
  };
};

const candidatesFor = (
  catalog: readonly VegaPluginMarketplaceEntry[],
  id: string,
  constraints: readonly Constraint[],
  target: VegaPluginLockTarget | undefined,
  request: VegaProjectPlugin | undefined,
): {
  readonly entries: readonly VegaPluginMarketplaceEntry[];
  readonly reason: SolveFailure["reason"];
} => {
  const byId = catalog.filter((entry) => entry.id === id);
  if (!byId.length) return { entries: [], reason: "missing" };
  if (constraints.some(({ range }) => !isValidVegaSemVerRange(range))) {
    return { entries: [], reason: "invalid-range" };
  }
  const validVersions = byId.filter((entry) => parseVegaSemVer(entry.version));
  if (!validVersions.length) return { entries: [], reason: "invalid-version" };
  const byVersion = validVersions.filter((entry) =>
    constraints.every(({ range }) => satisfiesVegaSemVer(entry.version, range)),
  );
  if (!byVersion.length) return { entries: [], reason: "version" };
  const bySource = request?.source
    ? byVersion.filter(
        (entry) =>
          vegaPluginSourceKey(entry.source) ===
          vegaPluginSourceKey(request.source!),
      )
    : byVersion;
  if (!bySource.length) return { entries: [], reason: "source" };
  const byTarget = bySource.filter((entry) =>
    isVegaPluginTargetCompatible(entry.targets, target),
  );
  if (!byTarget.length) return { entries: [], reason: "target" };
  const expectedCapabilities = request?.capabilities ?? [];
  const byCapability = byTarget.filter((entry) =>
    expectedCapabilities.every((capability) =>
      entry.capabilities?.includes(capability),
    ),
  );
  if (!byCapability.length) return { entries: [], reason: "capability" };
  return { entries: sortEntries(byCapability), reason: "version" };
};

const failureDiagnostic = (
  failure: SolveFailure,
  optional: boolean,
): VegaPluginResolutionDiagnostic => {
  const ranges = failure.constraints.map(({ range }) => range);
  const sources = failure.constraints.map(({ from }) => from);
  const severity = optional ? "warning" : "error";
  const suffix = sources.length ? ` (required by ${sources.join(", ")})` : "";
  switch (failure.reason) {
    case "missing":
      return {
        code: optional ? "optional-plugin-skipped" : "plugin-not-found",
        severity,
        pluginId: failure.id,
        ranges,
        message: `Plugin ${failure.id} was not found${suffix}`,
      };
    case "invalid-version":
      return {
        code: optional ? "optional-plugin-skipped" : "invalid-version",
        severity,
        pluginId: failure.id,
        ranges,
        message: `Plugin ${failure.id} has no valid semantic-version release${suffix}`,
      };
    case "invalid-range":
      return {
        code: optional ? "optional-plugin-skipped" : "invalid-version",
        severity,
        pluginId: failure.id,
        ranges,
        message: `Plugin ${failure.id} has an invalid semantic-version constraint: ${ranges.join(" and ")}${suffix}`,
      };
    case "source":
      return {
        code: optional ? "optional-plugin-skipped" : "source-mismatch",
        severity,
        pluginId: failure.id,
        ranges,
        message: `Plugin ${failure.id} has no release from the requested source${suffix}`,
      };
    case "target":
      return {
        code: optional ? "optional-plugin-skipped" : "target-incompatible",
        severity,
        pluginId: failure.id,
        ranges,
        message: `Plugin ${failure.id} has no release compatible with the requested target${suffix}`,
      };
    case "capability":
      return {
        code: optional ? "optional-plugin-skipped" : "capability-missing",
        severity,
        pluginId: failure.id,
        ranges,
        message: `Plugin ${failure.id} has no release with the required capabilities${suffix}`,
      };
    case "version":
      return {
        code: optional ? "optional-plugin-skipped" : "version-conflict",
        severity,
        pluginId: failure.id,
        ranges,
        message: `Plugin ${failure.id} cannot satisfy ${ranges.join(" and ")}${suffix}`,
      };
  }
};

const diagnosePermissions = (
  entries: readonly VegaPluginMarketplaceEntry[],
  request: VegaPluginResolutionRequest,
  requests: ReadonlyMap<string, VegaProjectPlugin>,
  diagnostics: VegaPluginResolutionDiagnostic[],
): void => {
  const globallyGranted = new Set(request.grantedPermissions ?? []);
  const denied = new Set(request.deniedPermissions ?? []);
  for (const entry of entries) {
    const locallyGranted = new Set(requests.get(entry.id)?.permissions ?? []);
    const required = [...(entry.permissions ?? [])].sort(compareStableText);
    const rejected = required.filter((permission) => denied.has(permission));
    if (rejected.length) {
      diagnostics.push({
        code: "permission-denied",
        severity: "error",
        pluginId: entry.id,
        permissions: rejected,
        message: `Plugin ${entry.id} requires denied permissions: ${rejected.join(", ")}`,
      });
    }
    const unreviewed = required.filter(
      (permission) =>
        !denied.has(permission) &&
        !globallyGranted.has(permission) &&
        !locallyGranted.has(permission),
    );
    if (unreviewed.length) {
      diagnostics.push({
        code: "permission-review-required",
        severity: "warning",
        pluginId: entry.id,
        permissions: unreviewed,
        message: `Plugin ${entry.id} requires permission review: ${unreviewed.join(", ")}`,
      });
    }
  }
};

const dependencyCycles = (
  entries: readonly VegaPluginMarketplaceEntry[],
  additionalDependencies: Readonly<
    Record<string, Readonly<Record<string, string>>>
  > = {},
): readonly (readonly string[])[] => {
  const selected = new Set(entries.map(({ id }) => id));
  const graph = new Map(
    entries.map((entry) => [
      entry.id,
      [
        ...Object.keys(entry.dependencies ?? {}),
        ...Object.keys(entry.optionalDependencies ?? {}),
        ...Object.keys(additionalDependencies[entry.id] ?? {}),
      ]
        .filter((id) => selected.has(id))
        .filter((id, index, values) => values.indexOf(id) === index)
        .sort(compareStableText),
    ]),
  );
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const seenCycles = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      const canonical = canonicalCycle(cycle);
      const key = canonical.join("\0");
      if (!seenCycles.has(key)) {
        seenCycles.add(key);
        cycles.push(canonical);
      }
      return;
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...graph.keys()].sort(compareStableText)) {
    visit(id);
  }
  return cycles.sort((left, right) =>
    compareStableText(left.join("\0"), right.join("\0")),
  );
};

const canonicalCycle = (cycle: readonly string[]): string[] => {
  const body = cycle.slice(0, -1);
  const start = body.reduce(
    (best, value, index) => (value < body[best]! ? index : best),
    0,
  );
  const rotated = [...body.slice(start), ...body.slice(0, start)];
  return [...rotated, rotated[0]!];
};

const addConstraint = (
  state: SolverState,
  id: string,
  range: string,
  from: string,
): SolverState => {
  const constraints = new Map(state.constraints);
  constraints.set(id, [...(constraints.get(id) ?? []), { range, from }]);
  return { selected: state.selected, constraints };
};

const cloneState = (state: SolverState): SolverState => ({
  selected: new Map(state.selected),
  constraints: new Map(
    [...state.constraints].map(([id, constraints]) => [id, [...constraints]]),
  ),
});

const sortEntries = (
  entries: VegaPluginMarketplaceEntry[],
): VegaPluginMarketplaceEntry[] =>
  entries.sort((left, right) => {
    const id = compareStableText(left.id, right.id);
    if (id) return id;
    let version = 0;
    try {
      version = compareVegaSemVer(right.version, left.version);
    } catch {
      version = compareStableText(right.version, left.version);
    }
    return (
      version ||
      compareStableText(
        vegaPluginSourceKey(left.source),
        vegaPluginSourceKey(right.source),
      )
    );
  });

const cloneSource = (
  source: VegaPluginMarketplaceEntry["source"],
): VegaPluginMarketplaceEntry["source"] => {
  switch (source.type) {
    case "registry":
      return Object.freeze({
        type: "registry",
        package: source.package,
        ...(source.registry !== undefined ? { registry: source.registry } : {}),
      });
    case "url":
      return Object.freeze({
        type: "url",
        url: source.url,
        integrity: source.integrity,
      });
    case "workspace":
      return Object.freeze({ type: "workspace", path: source.path });
    case "builtin":
      return Object.freeze({ type: "builtin", key: source.key });
  }
};

const cloneTarget = (target: VegaPluginLockTarget): VegaPluginLockTarget =>
  Object.freeze({
    ...(target.runtime !== undefined ? { runtime: target.runtime } : {}),
    ...(target.platform !== undefined ? { platform: target.platform } : {}),
    ...(target.architecture !== undefined
      ? { architecture: target.architecture }
      : {}),
    ...(target.engineVersion !== undefined
      ? { engineVersion: target.engineVersion }
      : {}),
    ...(target.apiVersion !== undefined ? { apiVersion: target.apiVersion } : {}),
  });

const sortedUnique = (values: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(values)].sort(compareStableText));

const failureResult = (
  diagnostics: VegaPluginResolutionDiagnostic[],
): VegaPluginResolutionResult =>
  Object.freeze({
    ok: false,
    entries: Object.freeze([]),
    lock: null,
    diagnostics: Object.freeze(diagnostics),
  });

const compareStableText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
