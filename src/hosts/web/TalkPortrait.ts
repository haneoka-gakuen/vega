import type { VegaWebUiSlotContext } from "./uiSlots";

/** One resource owner for dialogue portraits in every DOM presentation. */
export function createTalkPortrait(host: HTMLElement, context: VegaWebUiSlotContext) {
  const image = host.ownerDocument.createElement("img");
  image.className = "vega-talk-portrait";
  image.alt = "";
  image.hidden = true;
  image.style.cssText =
    "position:absolute;inset-inline-start:var(--vega-talk-portrait-left,3%);bottom:var(--vega-talk-portrait-bottom,24%);width:var(--vega-talk-portrait-width,10%);height:20%;object-fit:contain;pointer-events:none";
  host.append(image);
  let source = "",
    generation = 0,
    release: (() => void) | undefined,
    disposed = false;
  return {
    update() {
      const talk = context.state.talk;
      image.hidden = !source || !talk.enabled || !talk.visible || (talk.presentation ?? "default") !== "default";
      const next = talk.portraitRef ?? "";
      if (source === next) return;
      source = next;
      const request = ++generation;
      release?.();
      release = undefined;
      image.removeAttribute("src");
      image.hidden = true;
      if (!source || !context.resources) return;
      void context.resources
        .resolveRenderable(source, context.signal)
        .then((resource) => {
          if (disposed || request !== generation || context.signal.aborted) {
            resource.release();
            return;
          }
          release = resource.release;
          image.src = resource.url;
          image.hidden = !context.state.talk.enabled || !context.state.talk.visible;
        })
        .catch(() => undefined);
    },
    dispose() {
      disposed = true;
      generation++;
      release?.();
      image.remove();
    },
  };
}
