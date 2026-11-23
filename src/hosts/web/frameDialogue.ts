import { toCanvas } from "html-to-image";

const dialogueMarker = "[data-vega-frame-dialogue]";
const excluded = "[data-vega-frame-exclude]";

/** Capture only the UI layers that the mounted story presentation has marked for output. */
export function createWebFrameDialogue(host: HTMLElement, signal: AbortSignal) {
  const view = host.ownerDocument.defaultView;
  if (!view) return;
  let revision = 0;
  let cached: { key: string; canvas: HTMLCanvasElement } | undefined;
  let observer: MutationObserver | undefined;
  return async (target: CanvasRenderingContext2D): Promise<boolean> => {
    signal.throwIfAborted();
    if (!observer) {
      observer = new view.MutationObserver(() => ++revision);
      observer.observe(host, { attributes: true, childList: true, characterData: true, subtree: true });
      signal.addEventListener("abort", () => observer?.disconnect(), { once: true });
    }
    if (observer.takeRecords().length) revision++;
    const { clientWidth: width, clientHeight: height } = host;
    if (width < 1 || height < 1) return false;
    const layers = [...host.querySelectorAll<HTMLElement>(dialogueMarker)].filter(
      (element) => !element.hidden && element.getClientRects().length > 0,
    );
    if (!layers.length) return false;
    const scale = Math.min(target.canvas.width / width, target.canvas.height / height);
    const canvasWidth = Math.max(1, Math.round(width * scale));
    const canvasHeight = Math.max(1, Math.round(height * scale));
    const key = [revision, width, height, canvasWidth, canvasHeight].join("/");
    if (cached?.key !== key) {
      const canvas = await toCanvas(host, {
        width,
        height,
        canvasWidth,
        canvasHeight,
        pixelRatio: 1,
        skipFonts: true,
        style: { left: "0", top: "0", margin: "0", overflow: "hidden" },
        filter: (node) => {
          if (node.nodeType !== 1) return true;
          if (node.closest(excluded) || view.getComputedStyle(node).display === "none") return false;
          return layers.some((layer) => node.contains(layer) || layer.contains(node));
        },
      });
      signal.throwIfAborted();
      cached = { key, canvas };
    }
    target.drawImage(cached.canvas, (target.canvas.width - canvasWidth) / 2, (target.canvas.height - canvasHeight) / 2);
    return true;
  };
}
