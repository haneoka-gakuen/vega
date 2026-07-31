import {
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  shallowRef,
  watch,
  type PropType,
  type VNodeRef,
} from "vue";
import { advTextRenderSource } from "../core/AdvTextRenderValue";

/** A renderer-owned lifetime returned for one mounted rich-text value. */
export interface StoryRichTextDisposable {
  dispose(): void;
}

/** Structural source accepted by plugin-owned rich-text renderers. */
export interface StoryRichTextStructuredValue {
  readonly source: string;
  readonly format: string;
  readonly displayMode?: boolean;
  readonly language?: string;
}

export type StoryRichTextValue = string | StoryRichTextStructuredValue;

/**
 * Framework-neutral port for optional rich-text plugins.
 *
 * Vega core deliberately does not interpret the value. A renderer may replace
 * the target's children with DOM nodes and must return the lifetime for that
 * render. The component restores readable plain text if the renderer fails.
 */
export interface StoryRichTextRenderer {
  render(target: Element, value: unknown): StoryRichTextDisposable;
}

const isDisposable = (value: unknown): value is StoryRichTextDisposable =>
  Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as Partial<StoryRichTextDisposable>).dispose === "function",
  );

const isElementNode = (value: unknown): value is Element =>
  Boolean(
    value &&
      typeof value === "object" &&
      (value as Partial<Node>).nodeType === 1 &&
      typeof (value as Partial<Element>).replaceChildren === "function",
  );

export default defineComponent({
  name: "StoryRichText",
  props: {
    value: {
      type: [String, Object] as PropType<StoryRichTextValue>,
      default: "",
    },
    renderer: {
      type: Object as PropType<StoryRichTextRenderer>,
      default: undefined,
    },
  },
  setup(props) {
    const target = shallowRef<Element>();
    let activeRender: StoryRichTextDisposable | undefined;

    const disposeActiveRender = (): void => {
      const render = activeRender;
      activeRender = undefined;
      try {
        render?.dispose();
      } catch {
        // Plugin cleanup must not prevent a value update or Vue unmount.
      }
    };

    const renderValue = (): void => {
      const element = target.value;
      if (!element) return;

      disposeActiveRender();
      const fallback = advTextRenderSource(props.value);
      element.textContent = fallback;

      if (!props.renderer) return;
      try {
        const render = props.renderer.render(element, props.value);
        if (!isDisposable(render)) {
          throw new TypeError("Story rich-text renderer did not return a disposable");
        }
        activeRender = render;
      } catch {
        element.textContent = fallback;
      }
    };

    onMounted(renderValue);
    watch([() => props.value, () => props.renderer], renderValue, {
      flush: "post",
    });
    onBeforeUnmount(() => {
      disposeActiveRender();
      target.value = undefined;
    });

    const setTarget: VNodeRef = (element) => {
      target.value = isElementNode(element) ? element : undefined;
    };

    return () =>
      h(
        "span",
        {
          class: "adv-rich-text",
          ref: setTarget,
        },
        advTextRenderSource(props.value),
      );
  },
});
