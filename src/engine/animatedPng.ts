const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

interface PngFrame {
  header: Uint8Array<ArrayBuffer>;
  metadata: Uint8Array<ArrayBuffer>[];
  data: Uint8Array<ArrayBuffer>[];
  time: number;
}

function pngChunk(type: string, body: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(body.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, body.length);
  for (let index = 0; index < 4; index++) bytes[4 + index] = type.charCodeAt(index);
  bytes.set(body, 8);
  let crc = 0xffffffff;
  for (let index = 4; index < body.length + 8; index++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[index]!) & 255]!;
  view.setUint32(body.length + 8, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

async function readCanvasPng(canvas: HTMLCanvasElement, time: number): Promise<PngFrame> {
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Stage capture is unavailable"))), "image/png");
  });
  const bytes = new Uint8Array(await png.arrayBuffer());
  if (!signature.every((value, index) => bytes[index] === value)) throw new Error("Invalid PNG frame");
  const view = new DataView(bytes.buffer);
  const metadata: PngFrame["metadata"] = [];
  const data: PngFrame["data"] = [];
  let header: PngFrame["header"] | undefined;
  for (let start = signature.length; start + 12 <= bytes.length; ) {
    const length = view.getUint32(start);
    const end = start + 12 + length;
    if (end > bytes.length) throw new Error("Invalid PNG chunk");
    const type = String.fromCharCode(...bytes.subarray(start + 4, start + 8));
    if (type === "IHDR") header = bytes.slice(start + 8, end - 4);
    else if (type === "IDAT") data.push(bytes.slice(start + 8, end - 4));
    else if (type === "IEND") break;
    else if (!data.length) metadata.push(bytes.slice(start, end));
    start = end;
  }
  if (header?.length !== 13 || !data.length) throw new Error("Invalid PNG frame");
  return { header, metadata, data, time };
}

export function animatedPngFrames(canvas: HTMLCanvasElement, fps: number, maximumBytes: number) {
  const frames: PngFrame[] = [];
  let size = 0;
  return {
    async add(time: number) {
      const frame = await readCanvasPng(canvas, time);
      if (frames.length && !frames[0]!.header.every((value, index) => value === frame.header[index]))
        throw new Error("PNG frame format changed during recording");
      size += frame.data.reduce((sum, chunk) => sum + chunk.length + 16, 0) + 40;
      if (size > maximumBytes) throw new Error("Recording size limit reached");
      frames.push(frame);
    },
    finish(duration?: number): Blob {
      const first = frames[0];
      if (!first) throw new Error("Video recording produced no frames");
      const count = new Uint8Array(8);
      new DataView(count.buffer).setUint32(0, frames.length);
      const output: BlobPart[] = [
        signature,
        pngChunk("IHDR", first.header),
        ...first.metadata,
        pngChunk("acTL", count),
      ];
      let sequence = 0;
      frames.forEach((frame, index) => {
        const control = new Uint8Array(26);
        const view = new DataView(control.buffer);
        view.setUint32(0, sequence++);
        view.setUint32(4, canvas.width);
        view.setUint32(8, canvas.height);
        const delay = (frames[index + 1]?.time ?? Math.max(duration ?? 0, frame.time + 1 / fps)) - frame.time;
        view.setUint16(20, Math.max(1, Math.min(65535, Math.round(delay * fps))));
        view.setUint16(22, fps);
        output.push(pngChunk("fcTL", control));
        for (const data of frame.data) {
          if (!index) {
            output.push(pngChunk("IDAT", data));
          } else {
            const chunk = new Uint8Array(data.length + 4);
            new DataView(chunk.buffer).setUint32(0, sequence++);
            chunk.set(data, 4);
            output.push(pngChunk("fdAT", chunk));
          }
        }
      });
      frames.length = 0;
      return new Blob([...output, pngChunk("IEND", new Uint8Array())], { type: "image/apng" });
    },
  };
}
