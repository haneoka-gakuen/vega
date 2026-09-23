import { iterateAdvCommands } from "../core/AdvCommandTraversal";
import type {
  AdvCommand,
  AdvFontEntry,
  AdvRuntimeConfig,
  AdvStory,
  StoryFontFaceDescriptor,
} from "../types/AdvRuntime";
import type { StoryResourceResolver } from "../rendering/StorySceneBackend";
import { isCanonicalStoryResourceUrl } from "../runtime";
import type { StoryResolvedText } from "../runtime";

export type StoryResourceKind = "file" | "texture" | "audio" | "video" | "font";

/**
 * A directly addressable dependency discovered by a plugin or renderer.
 * Async enumerators may resolve an indirect manifest first, then return only
 * the leaf resources that the current story actually references.
 */
export interface StoryResourceDeclaration {
  readonly source: string;
  readonly kind?: StoryResourceKind;
  readonly label?: string;
  /** Playback/decode policy for `audio`; omitted audio defaults to `Se`. */
  readonly audioCategory?: "Bgm" | "Se" | "Voice";
  /** Required when `kind` is `font` and the face must be installed. */
  readonly font?: StoryFontFaceDescriptor;
}

export interface StoryResourcePreparationContext {
  readonly resolveLocalizedText?: (value: unknown) => StoryResolvedText;
  readonly story: AdvStory;
  readonly runtime: AdvRuntimeConfig;
  readonly resources: StoryResourceResolver;
  readonly signal: AbortSignal;
  /** The player's document. Absent in non-DOM hosts. */
  readonly document?: Document;
}

/** Story-wide resources and one-time preparation owned by a plugin surface. */
export interface StoryResourcePreparer {
  prepareStoryResources?(context: StoryResourcePreparationContext): void | Promise<void>;
  enumerateStoryResources?(
    context: StoryResourcePreparationContext,
  ): readonly StoryResourceDeclaration[] | Promise<readonly StoryResourceDeclaration[]>;
}

/** Resource discovery for an opcode extension's authored command payload. */
export interface StoryCommandResourcePreparer {
  prepareStoryResources?(context: StoryResourcePreparationContext): void | Promise<void>;
  enumerateCommandResources?(
    command: AdvCommand,
    context: StoryResourcePreparationContext,
  ): readonly StoryResourceDeclaration[] | Promise<readonly StoryResourceDeclaration[]>;
}

export interface StoryCommandResourceRegistration extends StoryCommandResourcePreparer {
  readonly opcode: number;
}

const RESOURCE_KINDS = new Set<StoryResourceKind>(["file", "texture", "audio", "video", "font"]);

const abortReason = (signal: AbortSignal): unknown => {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Story resource preparation was aborted");
  error.name = "AbortError";
  return error;
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortReason(signal);
};

/** Validate and freeze third-party declarations at the engine boundary. */
export const normalizeStoryResourceDeclarations = (
  value: readonly StoryResourceDeclaration[],
  owner = "story resource preparer",
): readonly StoryResourceDeclaration[] => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${owner} returned a non-array resource declaration`);
  }
  return Object.freeze(
    value.map((entry) => {
      if (!entry || typeof entry.source !== "string" || !entry.source.trim()) {
        throw new TypeError(`${owner} declared an empty resource source`);
      }
      const kind = entry.kind ?? "file";
      if (!RESOURCE_KINDS.has(kind)) {
        throw new TypeError(`${owner} declared an invalid resource kind`);
      }
      const label = entry.label?.trim();
      if (entry.label !== undefined && !label) {
        throw new TypeError(`${owner} declared an invalid resource label`);
      }
      const font = entry.font;
      const audioCategory = entry.audioCategory;
      if (audioCategory !== undefined && !(["Bgm", "Se", "Voice"] as const).includes(audioCategory)) {
        throw new TypeError(`${owner} declared an invalid audio category`);
      }
      if (kind !== "audio" && audioCategory !== undefined) {
        throw new TypeError(`${owner} attached an audio category to a ${kind} resource`);
      }
      if (kind === "font") {
        if (!font || typeof font.family !== "string" || !font.family.trim()) {
          throw new TypeError(`${owner} declared a font without a family`);
        }
      } else if (font !== undefined) {
        throw new TypeError(`${owner} attached font metadata to a ${kind} resource`);
      }
      return Object.freeze({
        source: entry.source.trim(),
        kind,
        ...(label ? { label } : {}),
        ...(kind === "audio" ? { audioCategory: audioCategory ?? "Se" } : {}),
        ...(font
          ? {
              font: Object.freeze({
                ...font,
                family: font.family.trim(),
              }),
            }
          : {}),
      });
    }),
  );
};

export const prepareStoryResourcePreparers = async (
  preparers: readonly StoryResourcePreparer[],
  context: StoryResourcePreparationContext,
): Promise<void> => {
  throwIfAborted(context.signal);
  await Promise.all(
    preparers.map(async (preparer) => {
      await preparer.prepareStoryResources?.(context);
      throwIfAborted(context.signal);
    }),
  );
};

export const enumerateStoryResourcePreparers = async (
  preparers: readonly StoryResourcePreparer[],
  context: StoryResourcePreparationContext,
): Promise<readonly StoryResourceDeclaration[]> => {
  throwIfAborted(context.signal);
  const groups = await Promise.all(
    preparers.map(async (preparer, index) => {
      if (!preparer.enumerateStoryResources) return [] as const;
      const declarations = await preparer.enumerateStoryResources(context);
      throwIfAborted(context.signal);
      return normalizeStoryResourceDeclarations(declarations, `story resource preparer ${index + 1}`);
    }),
  );
  return Object.freeze(groups.flat());
};

export const prepareStoryCommandResourcePreparers = async (
  registrations: readonly StoryCommandResourceRegistration[],
  context: StoryResourcePreparationContext,
): Promise<void> => {
  throwIfAborted(context.signal);
  await Promise.all(
    registrations.map(async (registration) => {
      await registration.prepareStoryResources?.(context);
      throwIfAborted(context.signal);
    }),
  );
};

/** Enumerate each extension only for commands registered to its opcode. */
export const enumerateStoryCommandResources = async (
  registrations: readonly StoryCommandResourceRegistration[],
  context: StoryResourcePreparationContext,
): Promise<readonly StoryResourceDeclaration[]> => {
  throwIfAborted(context.signal);
  const byOpcode = new Map<number, StoryCommandResourceRegistration>();
  for (const registration of registrations) {
    if (registration.enumerateCommandResources) {
      byOpcode.set(registration.opcode, registration);
    }
  }
  const groups = await Promise.all(
    [...iterateAdvCommands(context.story.commands ?? [])].map(async (command) => {
      const opcode = Number(command.command);
      const registration = byOpcode.get(opcode);
      if (!registration?.enumerateCommandResources) return [] as const;
      const declarations = await registration.enumerateCommandResources(command, context);
      throwIfAborted(context.signal);
      return normalizeStoryResourceDeclarations(declarations, `command extension ${opcode}`);
    }),
  );
  return Object.freeze(groups.flat());
};

/** Collect story-wide and opcode-specific declarations without loading them. */
export const collectStoryResourceDeclarations = async (
  preparers: readonly StoryResourcePreparer[],
  commandPreparers: readonly StoryCommandResourceRegistration[],
  context: StoryResourcePreparationContext,
): Promise<readonly StoryResourceDeclaration[]> => {
  const [storyResources, commandResources] = await Promise.all([
    enumerateStoryResourcePreparers(preparers, context),
    enumerateStoryCommandResources(commandPreparers, context),
  ]);
  const unique = new Map<string, StoryResourceDeclaration>();
  for (const declaration of [...storyResources, ...commandResources]) {
    const key = JSON.stringify([declaration.kind, declaration.source, declaration.audioCategory, declaration.font]);
    if (!unique.has(key)) unique.set(key, declaration);
  }
  return Object.freeze([...unique.values()]);
};

const runtimeFontDeclarations = (runtime: AdvRuntimeConfig): readonly StoryResourceDeclaration[] =>
  (runtime.fonts ?? []).map(({ source, ...font }: AdvFontEntry) => ({
    source,
    kind: "font" as const,
    label: `font ${font.family}`,
    font,
  }));

/** Built-in story assets that are not attached to a renderer command. */
export const runtimeStoryResourcePreparer: StoryResourcePreparer = Object.freeze({
  enumerateStoryResources({ story, runtime }: StoryResourcePreparationContext) {
    const textures = new Set<string>();
    const iconImages = runtime.chatAssets?.iconImagesByAsset ?? {};
    for (const command of iterateAdvCommands(story.commands ?? [])) {
      const master =
        runtime.chatAssets?.masters?.[String(command.targetChatID ?? "")] ??
        runtime.chatAssets?.presetsByRef?.[String(command.chatPresetRef ?? "")];
      const isChatCommand = Boolean(
        command.targetChatID !== undefined ||
        command.chatMemoryId ||
        command.chatWindowAssetName ||
        command.chatIconAssetName ||
        master,
      );
      if (!isChatCommand) continue;
      const reference = String(
        command.chatIconAssetName || master?.chatIconAssetName || command.targetAssetName || "",
      ).trim();
      const source = iconImages[reference];
      if (typeof source === "string" && source.trim() && isCanonicalStoryResourceUrl(source.trim())) {
        textures.add(source.trim());
      }
    }
    return Object.freeze([
      ...[...textures].map((source) => ({
        source,
        kind: "texture" as const,
        label: "chat UI",
      })),
      ...runtimeFontDeclarations(runtime),
    ]);
  },
});

const loadedFonts = new WeakMap<Document, Map<string, Promise<void>>>();

const fontCacheKey = (declaration: StoryResourceDeclaration): string =>
  JSON.stringify([declaration.source, declaration.font]);

const cssFontSource = (url: string, format?: string): string =>
  `url(${JSON.stringify(url)})${format ? ` format(${JSON.stringify(format)})` : ""}`;

const toFontFaceDescriptors = (font: StoryFontFaceDescriptor): FontFaceDescriptors => ({
  ...(font.style ? { style: font.style } : {}),
  ...(font.weight !== undefined ? { weight: String(font.weight) } : {}),
  ...(font.stretch ? { stretch: font.stretch } : {}),
  ...(font.unicodeRange ? { unicodeRange: font.unicodeRange } : {}),
  ...(font.featureSettings ? { featureSettings: font.featureSettings } : {}),
  ...(font.variationSettings ? { variationSettings: font.variationSettings } : {}),
  ...(font.display ? { display: font.display } : {}),
});

/** Decode and install every declared font before the loading screen exits. */
export const prepareDeclaredStoryFonts = async (
  declarations: readonly StoryResourceDeclaration[],
  context: StoryResourcePreparationContext,
): Promise<void> => {
  const document = context.document;
  const FontFaceConstructor = document?.defaultView?.FontFace;
  if (!document?.fonts || !FontFaceConstructor) return;
  const registry = loadedFonts.get(document) ?? new Map<string, Promise<void>>();
  loadedFonts.set(document, registry);
  const fonts = normalizeStoryResourceDeclarations(declarations).filter(
    (declaration) => declaration.kind === "font" && declaration.font,
  );
  await Promise.all(
    fonts.map(async (declaration) => {
      throwIfAborted(context.signal);
      const key = fontCacheKey(declaration);
      let pending = registry.get(key);
      if (!pending) {
        pending = (async () => {
          const renderable = await context.resources.resolveRenderable(declaration.source, context.signal);
          try {
            throwIfAborted(context.signal);
            const metadata = declaration.font!;
            const face = new FontFaceConstructor(
              metadata.family,
              cssFontSource(renderable.url, metadata.format),
              toFontFaceDescriptors(metadata),
            );
            await face.load();
            throwIfAborted(context.signal);
            document.fonts.add(face);
          } finally {
            renderable.release();
          }
        })().catch((error) => {
          registry.delete(key);
          throw error;
        });
        registry.set(key, pending);
      }
      await pending;
      throwIfAborted(context.signal);
    }),
  );
};
