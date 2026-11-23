// QuickTime PNG video samples retain the canvas alpha channel; sowt carries interleaved signed little-endian PCM.
const ascii = (value: string) => new TextEncoder().encode(value);
const zero = (length: number) => new Uint8Array(length);
function integers(bytes: 2 | 4, values: readonly number[]) {
  const data = zero(bytes * values.length);
  const view = new DataView(data.buffer);
  values.forEach((value, index) => {
    if (bytes === 2) view.setUint16(index * bytes, value);
    else view.setUint32(index * bytes, value);
  });
  return data;
}
const u32 = (...values: number[]) => integers(4, values);
const u16 = (...values: number[]) => integers(2, values);
function box(type: string, ...parts: (Blob | Uint8Array<ArrayBuffer>)[]): Blob {
  const body = new Blob(parts);
  return new Blob([u32(8 + body.size), ascii(type), body]);
}
const matrix = u32(65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824);
const movieScale = 1000;
interface Track {
  id: number;
  scale: number;
  duration: number;
  width: number;
  height: number;
  samples: number;
  description: Blob;
  sampleSizes: Blob;
  timing: Blob;
  offset: number;
}
function trackBox(track: Track) {
  const { width, height, scale, duration, id, offset, description, timing, sampleSizes, samples } = track;
  const video = id === 1;
  const header = box(
    "tkhd",
    u32(7, 0, 0, id, 0, Math.round((duration * movieScale) / scale)),
    zero(8),
    u16(0, 0, video ? 0 : 256, 0),
    matrix,
    u32(width * 65536, height * 65536),
  );
  const mediaHeader = box("mdhd", u32(0, 0, 0, scale, duration), u16(0, 0));
  const handler = box("hdlr", u32(0), ascii("mhlr"), ascii(video ? "vide" : "soun"), zero(13));
  const dataReference = box("dinf", box("dref", u32(0, 1), box("url ", u32(1))));
  const tables = box(
    "stbl",
    box("stsd", u32(0, 1), description),
    timing,
    box("stsc", u32(0, 1, 1, samples, 1)),
    sampleSizes,
    box("stco", u32(0, 1, offset)),
  );
  return box(
    "trak",
    header,
    box(
      "mdia",
      mediaHeader,
      handler,
      box("minf", video ? box("vmhd", u32(1), zero(8)) : box("smhd", zero(8)), dataReference, tables),
    ),
  );
}
async function pcmTrack(wav: Blob, offset: number) {
  const view = new DataView(await wav.slice(0, 12).arrayBuffer());
  if (view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645) throw new Error("Invalid PCM recording");
  let channels = 0,
    rate = 0,
    block = 0;
  for (let start = 12; start + 8 <= wav.size; ) {
    const chunk = new DataView(await wav.slice(start, start + 32).arrayBuffer());
    const tag = chunk.getUint32(0),
      size = chunk.getUint32(4, true);
    if (start + 8 + size > wav.size) throw new Error("Invalid PCM recording");
    if (tag === 0x666d7420) {
      if (![1, 0xfffe].includes(chunk.getUint16(8, true)) || chunk.getUint16(22, true) !== 16)
        throw new Error("Unsupported PCM recording");
      channels = chunk.getUint16(10, true);
      rate = chunk.getUint32(12, true);
      block = chunk.getUint16(20, true);
    }
    if (tag === 0x64617461 && channels && rate && block === channels * 2 && size >= block) {
      const samples = Math.floor(size / block);
      const track: Track = {
        id: 2,
        scale: rate,
        duration: samples,
        width: 0,
        height: 0,
        samples,
        offset,
        description: box("sowt", zero(6), u16(1), zero(8), u16(channels, 16, 0, 0), u32(rate * 65536)),
        sampleSizes: box("stsz", u32(0, block, samples)),
        timing: box("stts", u32(0, 1, samples, 1)),
      };
      return { track, data: wav.slice(start + 8, start + 8 + samples * block) };
    }
    start += 8 + size + (size % 2);
  }
  throw new Error("No PCM samples were recorded");
}

export function pngMovieFrames(canvas: HTMLCanvasElement, fps: number, maximumBytes: number) {
  const frames: Blob[] = [],
    starts: number[] = [];
  let frameBytes = 0;
  let durationSeconds: number | undefined;
  return {
    get durationSeconds() {
      return durationSeconds;
    },
    async add(time: number) {
      const png = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error("Stage capture is unavailable"))),
          "image/png",
        ),
      );
      frameBytes += png.size;
      if (frameBytes > maximumBytes) throw new Error("Recording size limit reached");
      frames.push(png);
      starts.push(Math.round(time * fps));
    },
    async finish(elapsed: number, wav?: Blob) {
      const ftyp = box("ftyp", ascii("qt  "), u32(0), ascii("qt  "));
      const offset = ftyp.size + 8;
      const audio = wav ? await pcmTrack(wav, offset + frameBytes) : undefined;
      const endFrame = Math.max(
        starts[starts.length - 1]! + 1,
        Math.round((audio ? audio.track.duration / audio.track.scale : elapsed) * fps),
      );
      durationSeconds = endFrame / fps;
      const timeline: number[] = [];
      for (let i = 0; i < starts.length; i++) {
        const step = (starts[i + 1] ?? endFrame) - starts[i]!;
        if (timeline.length && timeline[timeline.length - 1] === step) timeline[timeline.length - 2]!++;
        else timeline.push(1, step);
      }
      const video: Track = {
        id: 1,
        width: canvas.width,
        height: canvas.height,
        scale: fps,
        duration: endFrame,
        samples: frames.length,
        offset,
        description: box(
          "png ",
          zero(6),
          u16(1),
          zero(16),
          u16(canvas.width, canvas.height),
          u32(72 * 65536, 72 * 65536, 0),
          u16(1),
          zero(32),
          u16(32, 65535),
        ),
        sampleSizes: box(
          "stsz",
          u32(0, 0, frames.length),
          integers(
            4,
            frames.map((frame) => frame.size),
          ),
        ),
        timing: box("stts", u32(0, timeline.length / 2), integers(4, timeline)),
      };
      const duration = Math.round(
        Math.max(video.duration / fps, audio ? audio.track.duration / audio.track.scale : 0) * movieScale,
      );
      const header = box(
        "mvhd",
        u32(0, 0, 0, movieScale, duration, 65536),
        u16(256),
        zero(10),
        matrix,
        zero(24),
        u32(3),
      );
      const data = box("mdat", new Blob(frames), ...(audio ? [audio.data] : []));
      const result = new Blob(
        [ftyp, data, box("moov", header, trackBox(video), ...(audio ? [trackBox(audio.track)] : []))],
        { type: "video/quicktime" },
      );
      frames.length = starts.length = 0;
      if (result.size > maximumBytes) throw new Error("Recording size limit reached");
      return result;
    },
  };
}
