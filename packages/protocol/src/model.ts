export type VegaJsonPrimitive = string | number | boolean | null;
export type VegaJsonValue = VegaJsonPrimitive | VegaJsonObject | VegaJsonValue[];
export interface VegaJsonObject {
  [key: string]: VegaJsonValue;
}

export type VegaLocalizedText = string | Readonly<Record<string, string>>;

export type VegaProjectLanguage = Readonly<{
  /** A canonical BCP 47 language tag. */
  tag: string;
  label?: VegaLocalizedText;
  /** Font asset ids, in preferred order. */
  fontAssets?: string[];
}>;

export type VegaProjectLocalizationV1 = Readonly<{
  version: 1;
  languages: VegaProjectLanguage[];
  defaultLanguage: string;
  fallbackLanguage?: string;
}>;

export type VegaProjectLocalization = VegaProjectLocalizationV1;

export type VegaProjectMetadata = Readonly<Record<string, VegaJsonValue>> &
  Readonly<{
    /**
     * Optional, versioned localization metadata. Protocol-v1 readers that do
     * not understand this key continue to treat it as ordinary metadata.
     */
    "vega:localization"?: VegaProjectLocalization;
  }>;

export interface VegaProject {
  readonly format: "vega-project";
  readonly formatVersion: 1;
  readonly id: string;
  readonly title: VegaLocalizedText;
  readonly entryScene: string;
  readonly engine?: {
    readonly minimumVersion?: string;
    readonly features?: readonly string[];
  };
  readonly metadata?: VegaProjectMetadata;
  readonly assets?: Readonly<Record<string, VegaAsset>>;
  readonly plugins?: readonly VegaProjectPlugin[];
  readonly scenes: Readonly<Record<string, VegaScene>>;
}

export interface VegaScene {
  readonly id: string;
  readonly title?: VegaLocalizedText;
  readonly commands: readonly VegaCommand[];
  readonly metadata?: Readonly<Record<string, VegaJsonValue>>;
}

/**
 * `command` keeps the original ADV field name so native 0-100 command
 * semantics survive a lossless import/export round trip.
 */
export interface VegaCommand {
  readonly command: number | string;
  readonly commandId?: string;
  readonly index?: number;
  readonly key?: string;
  readonly name?: string;
  readonly noWait?: boolean;
  readonly [field: string]: VegaJsonValue | undefined;
}

export interface VegaAsset {
  readonly type: "image" | "audio" | "video" | "model" | "font" | "data" | "other";
  readonly source: string;
  readonly hash?: string;
  readonly mediaType?: string;
  readonly bytes?: number;
  readonly variants?: Readonly<Record<string, string>>;
}

export interface VegaProjectPlugin {
  readonly id: string;
  readonly version: string;
  readonly required?: boolean;
  readonly configuration?: Readonly<Record<string, VegaJsonValue>>;
  /** Capabilities the project expects the selected plugin version to expose. */
  readonly capabilities?: readonly VegaPluginCapabilityId[];
  /** Permissions the project is prepared to grant to this plugin. */
  readonly permissions?: readonly VegaPluginPermissionId[];
  /** Additional plugin constraints that must resolve with this request. */
  readonly dependencies?: VegaPluginDependencies;
  readonly targets?: VegaPluginTargets;
  readonly source?: VegaPluginInstallSource;
}

export type VegaPluginCapabilityId = string;
export type VegaPluginPermissionId = string;
export type VegaPluginDependencies = Readonly<Record<string, string>>;

/**
 * A runtime that an adapter can use but that the plugin package does not
 * distribute. Hosts may inject it at runtime; application packagers may only
 * include a user-supplied, separately licensed artifact through an explicit
 * build opt-in.
 */
export interface VegaExternalRuntimeRequirement {
  readonly id: string;
  readonly name: string;
  /** Runtime release or compatible range accepted by this adapter. */
  readonly version: string;
  readonly license: string;
  readonly homepage?: string;
  readonly optional?: boolean;
  readonly provisioning: readonly ("host" | "application-bundle")[];
}

/**
 * Portable compatibility constraints. Every populated dimension is an
 * allow-list; an omitted dimension is unconstrained.
 */
export interface VegaPluginTargets {
  readonly runtimes?: readonly string[];
  readonly platforms?: readonly string[];
  readonly architectures?: readonly string[];
  readonly engineVersion?: string;
  readonly apiVersions?: readonly number[];
}

/**
 * Describes where an installer may obtain a plugin. The protocol only carries
 * metadata; Vega's resolver never downloads or executes this source.
 */
export type VegaPluginInstallSource =
  | {
      readonly type: "registry";
      readonly package: string;
      readonly registry?: string;
    }
  | {
      readonly type: "url";
      readonly url: string;
      readonly integrity: string;
    }
  | {
      readonly type: "workspace";
      readonly path: string;
    }
  | {
      readonly type: "builtin";
      readonly key: string;
    };

export interface VegaPluginMarketplaceEntry {
  readonly format: "vega-plugin-entry";
  readonly formatVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly description?: string;
  readonly publisher?: string;
  readonly tags?: readonly string[];
  readonly capabilities?: readonly VegaPluginCapabilityId[];
  readonly permissions?: readonly VegaPluginPermissionId[];
  readonly dependencies?: VegaPluginDependencies;
  readonly optionalDependencies?: VegaPluginDependencies;
  readonly externalRuntimes?: readonly VegaExternalRuntimeRequirement[];
  readonly targets?: VegaPluginTargets;
  readonly source: VegaPluginInstallSource;
  /** Subresource-integrity compatible digest for the resolved package. */
  readonly integrity?: string;
}

export interface VegaPluginCatalog {
  readonly format: "vega-plugin-catalog";
  readonly formatVersion: 1;
  readonly id: string;
  /**
   * Entries may contain multiple versions of a plugin. Each `id@version`
   * identity is unique; consumers apply a deterministic sort before display
   * or resolution.
   */
  readonly plugins: readonly VegaPluginMarketplaceEntry[];
}

export interface VegaPluginLock {
  readonly format: "vega-plugin-lock";
  readonly formatVersion: 1;
  readonly projectFormatVersion: 1;
  readonly target?: VegaPluginLockTarget;
  /** Entries are unique and sorted by id. */
  readonly plugins: readonly VegaPluginLockEntry[];
}

export interface VegaPluginLockTarget {
  readonly runtime?: string;
  readonly platform?: string;
  readonly architecture?: string;
  readonly engineVersion?: string;
  readonly apiVersion?: number;
}

export interface VegaPluginLockEntry {
  readonly id: string;
  readonly version: string;
  readonly source: VegaPluginInstallSource;
  readonly integrity?: string;
  /** Exact selected versions, with keys sorted by plugin id. */
  readonly dependencies: VegaPluginDependencies;
  readonly capabilities?: readonly VegaPluginCapabilityId[];
  readonly permissions?: readonly VegaPluginPermissionId[];
  readonly externalRuntimes?: readonly VegaExternalRuntimeRequirement[];
}

export interface VegaBundle {
  readonly format: "vega-bundle";
  readonly formatVersion: 1;
  readonly compiler: { readonly name: string; readonly version: string };
  readonly project: VegaProject;
  readonly integrity?: Readonly<Record<string, string>>;
}
