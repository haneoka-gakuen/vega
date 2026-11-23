import { GIFEncoder, applyPalette, quantize } from "gifenc";

export function animatedGifFrames(canvas: HTMLCanvasElement, fps: number, maximumBytes: number) {
  const encoder = GIFEncoder();
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Stage capture is unavailable");
  let pending: { palette: number[][]; pixels: Uint8Array; start: number } | undefined;
  const flush = (end: number) => {
    if (!pending) return;
    const transparentIndex = pending.palette.findIndex((color) => color[3] === 0);
    encoder.writeFrame(pending.pixels, canvas.width, canvas.height, {
      palette: pending.palette,
      delay: Math.max(10, (end - pending.start) * 10),
      repeat: 0,
      transparent: transparentIndex >= 0,
      transparentIndex: Math.max(0, transparentIndex),
      dispose: 2,
    });
    if (encoder.bytesView().byteLength > maximumBytes) throw new Error("Recording size limit reached");
  };
  return {
    async add(time: number) {
      const start = Math.round(time * 100);
      flush(start);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const palette = quantize(data, 256, { format: "rgba4444", oneBitAlpha: true });
      pending = { palette, pixels: applyPalette(data, palette, "rgba4444"), start };
    },
    finish(duration: number) {
      flush(Math.max(Math.round(duration * 100), (pending?.start ?? 0) + Math.round(100 / fps)));
      encoder.finish();
      return new Blob([encoder.bytesView()], { type: "image/gif" });
    },
  };
}
