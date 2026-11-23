import { finalizeRecordingWebM } from "./recordingWebM";
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  MediaStreamAudioTrackSource,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  WavOutputFormat,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
} from "mediabunny";
import { pngMovieFrames } from "./pngMovie";
import { animatedGifFrames } from "./animatedGif";
import { animatedPngFrames } from "./animatedPng";

const maximumBytes = 512 * 1024 * 1024;

export interface StageVideoOptions {
  width: number;
  height: number;
  fps: number;
  transparentBackground?: boolean;
  container?: "webm" | "mp4" | "mov" | "gif" | "apng" | "wav";
}

export interface StageEncoding {
  readonly durationSeconds?: number;
  stop(): Promise<Blob>;
}

export interface FixedStageEncoder {
  add(time: number): Promise<void>;
  finish(duration: number, audio?: AudioBuffer): Promise<Blob>;
  cancel?(): Promise<void>;
}

type FrameDialoguePainter = (context: CanvasRenderingContext2D) => Promise<void>;

function captionSurface(canvas: HTMLCanvasElement, paint?: FrameDialoguePainter) {
  if (!paint) return { surface: canvas, draw: () => undefined };
  const surface = canvas.ownerDocument.createElement("canvas");
  surface.width = canvas.width;
  surface.height = canvas.height;
  const overlay = surface.getContext("2d");
  if (!overlay) throw new Error("Stage capture is unavailable");
  return {
    surface,
    async draw() {
      overlay.clearRect(0, 0, canvas.width, canvas.height);
      overlay.drawImage(canvas, 0, 0);
      await paint(overlay);
    },
  };
}

async function encodeOfflineWav(buffer: AudioBuffer): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({ format: new WavOutputFormat(), target });
  const audio = new AudioBufferSource({ codec: "pcm-s16", bitrate: 1_536_000 });
  output.addAudioTrack(audio);
  try {
    await output.start();
    await audio.add(buffer);
    await output.finalize();
    if (!target.buffer) throw new Error("Audio export produced no samples");
    return new Blob([target.buffer], { type: "audio/wav" });
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  }
}

export async function beginFixedStageEncoding(
  canvas: HTMLCanvasElement,
  options: StageVideoOptions,
  paint?: FrameDialoguePainter,
): Promise<FixedStageEncoder> {
  const { surface, draw } = captionSurface(canvas, paint);
  const { container = "webm", fps, width, height } = options;
  if (container === "wav")
    return {
      async add() {},
      async finish(_duration, audio) {
        if (!audio) throw new Error("Audio export produced no samples");
        return encodeOfflineWav(audio);
      },
    };
  if (container === "mov" && options.transparentBackground) {
    const writer = pngMovieFrames(surface, fps, maximumBytes);
    return {
      async add(time) {
        await draw();
        return writer.add(time);
      },
      async finish(duration, audio) {
        return writer.finish(duration, audio && (await encodeOfflineWav(audio)));
      },
    };
  }
  if (container === "gif" || container === "apng") {
    const writer = (container === "gif" ? animatedGifFrames : animatedPngFrames)(surface, fps, maximumBytes);
    return {
      async add(time) {
        await draw();
        return writer.add(time);
      },
      finish(duration) {
        return Promise.resolve(writer.finish(duration));
      },
    };
  }
  const bitrate = videoBitrate(height);
  const codecs = container === "webm" ? (["vp9", "vp8"] as const) : (["avc"] as const);
  const alpha = container === "webm" && options.transparentBackground ? "keep" : "discard";
  const support = await Promise.all(codecs.map((codec) => canEncodeVideo(codec, { width, height, bitrate, alpha })));
  const codec = codecs[support.indexOf(true)];
  if (!codec) throw new Error("Video recording unavailable");
  const audioCodec =
    container === "webm" ? "opus" : (await canEncodeAudio("aac")) ? "aac" : container === "mov" ? "pcm-s16" : "opus";
  if (!(await canEncodeAudio(audioCodec))) throw new Error("Audio export encoder is unavailable");
  const target = new BufferTarget();
  target.onwrite = (_start, end) => {
    if (end > maximumBytes) throw new Error("Recording size limit reached");
  };
  const output = new Output({
    format:
      container === "mp4"
        ? new Mp4OutputFormat()
        : container === "mov"
          ? new MovOutputFormat()
          : new WebMOutputFormat(),
    target,
  });
  const video = new CanvasSource(surface, { codec, bitrate, alpha });
  const audio = new AudioBufferSource({ codec: audioCodec, bitrate: 192_000 });
  output.addVideoTrack(video, { frameRate: fps });
  output.addAudioTrack(audio);
  await output.start();
  return {
    async add(time) {
      await draw();
      return video.add(time, 1 / fps, { keyFrame: time === 0 });
    },
    async finish(_duration, buffer) {
      if (!buffer) throw new Error("Audio export produced no samples");
      await audio.add(buffer);
      await output.finalize();
      if (!target.buffer?.byteLength) throw new Error("Video recording produced no frames");
      return new Blob([target.buffer], { type: output.format.mimeType });
    },
    cancel: () => output.cancel(),
  };
}

const videoBitrate = (height: number) => (height >= 1080 ? 10_000_000 : 6_000_000);

export async function beginAudioEncoding(track: MediaStreamTrack | undefined): Promise<StageEncoding> {
  if (!track) throw new Error("Audio device unavailable");
  const target = new BufferTarget();
  const output = new Output({ format: new WavOutputFormat(), target });
  const audio = new MediaStreamAudioTrackSource(
    track as ConstructorParameters<typeof MediaStreamAudioTrackSource>[0],
    { codec: "pcm-s16", bitrate: 1_536_000 },
    { timestampBase: "zero" },
  );
  let failed: unknown;
  void audio.errorPromise.catch((error) => {
    failed = error;
  });
  target.onwrite = (_start, end) => {
    if (end > maximumBytes) throw new Error("Recording size limit reached");
  };
  output.addAudioTrack(audio);
  try {
    await output.start();
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  }
  return {
    async stop() {
      try {
        if (failed) throw failed;
        await output.finalize();
        if (failed) throw failed;
        if (!target.buffer?.byteLength) throw new Error("Audio device unavailable");
        return new Blob([target.buffer], { type: "audio/wav" });
      } catch (error) {
        await output.cancel().catch(() => {});
        throw error;
      }
    },
  };
}

async function startPacedFrames(
  fps: number,
  write: (time: number, first: boolean) => Promise<void>,
  active: () => boolean = () => true,
): Promise<() => Promise<number>> {
  const start = performance.now();
  await write(0, true);
  let index = 0;
  let frame = 0;
  let pending = Promise.resolve();
  let stopped = false;
  let failed: unknown;
  const capture = (now: number) => {
    if (stopped || !active()) return;
    const next = Math.floor((Math.max(0, now - start) * fps) / 1000);
    if (next <= index) {
      frame = requestAnimationFrame(capture);
      return;
    }
    index = next;
    pending = Promise.resolve()
      .then(() => write(next / fps, false))
      .then(
        () => {
          if (!stopped) frame = requestAnimationFrame(capture);
        },
        (error: unknown) => {
          failed = error;
        },
      );
  };
  frame = requestAnimationFrame(capture);
  return async () => {
    const duration = (performance.now() - start) / 1000;
    stopped = true;
    cancelAnimationFrame(frame);
    await pending;
    if (failed) throw failed;
    return duration;
  };
}

export async function beginFrameEncoding(
  canvas: HTMLCanvasElement,
  audioTrack: MediaStreamTrack | undefined,
  options: StageVideoOptions,
  paint?: FrameDialoguePainter,
): Promise<StageEncoding | undefined> {
  const { surface, draw } = captionSurface(canvas, paint);
  if (options.container === "mov" && options.transparentBackground) {
    const writer = pngMovieFrames(surface, options.fps, maximumBytes);
    const audio = audioTrack ? await beginAudioEncoding(audioTrack) : undefined;
    let stopFrames: Awaited<ReturnType<typeof startPacedFrames>>;
    try {
      stopFrames = await startPacedFrames(options.fps, async (time) => {
        await draw();
        return writer.add(time);
      });
    } catch (error) {
      await audio?.stop().catch(() => {});
      throw error;
    }
    return {
      get durationSeconds() {
        return writer.durationSeconds;
      },
      async stop() {
        const [duration, wav] = await Promise.all([stopFrames(), audio?.stop()]);
        return writer.finish(duration, wav);
      },
    };
  }
  if (options.container === "apng" || options.container === "gif") {
    const frames = options.container === "gif" ? animatedGifFrames : animatedPngFrames;
    const writer = frames(surface, options.fps, maximumBytes);
    const stop = await startPacedFrames(options.fps, async (time) => {
      await draw();
      return writer.add(time);
    });
    return {
      async stop() {
        return writer.finish(await stop());
      },
    };
  }
  if (options.container === "wav") return;
  if (typeof VideoEncoder === "undefined") return;
  const container = options.container ?? "webm";
  const alpha = container === "webm" && options.transparentBackground ? "keep" : "discard";
  const codecs = container === "webm" ? (["vp9", "vp8"] as const) : (["avc"] as const);
  const bitrate = videoBitrate(options.height);
  const support = await Promise.all(
    codecs.map((codec) => canEncodeVideo(codec, { width: options.width, height: options.height, bitrate, alpha })),
  );
  const codec = codecs[support.indexOf(true)];
  if (!codec) return;
  const audioCodec =
    container === "webm" ? "opus" : (await canEncodeAudio("aac")) ? "aac" : container === "mov" ? "pcm-s16" : "opus";
  if (audioTrack && !(await canEncodeAudio(audioCodec))) return;

  const target = new BufferTarget();
  const output = new Output({
    format:
      container === "mp4"
        ? new Mp4OutputFormat()
        : container === "mov"
          ? new MovOutputFormat()
          : new WebMOutputFormat(),
    target,
  });
  let failed: unknown;
  target.onwrite = (_start, end) => {
    if (end > maximumBytes) throw new Error("Recording size limit reached");
  };
  const video = new CanvasSource(surface, { codec, bitrate, alpha });
  output.addVideoTrack(video, { frameRate: options.fps });
  if (audioTrack) {
    const audio = new MediaStreamAudioTrackSource(
      audioTrack as ConstructorParameters<typeof MediaStreamAudioTrackSource>[0],
      { codec: audioCodec, bitrate: 192_000 },
      { timestampBase: "zero" },
    );
    void audio.errorPromise.catch((error) => {
      failed = error;
    });
    output.addAudioTrack(audio);
  }

  let stopFrames: Awaited<ReturnType<typeof startPacedFrames>>;
  try {
    await output.start();
    stopFrames = await startPacedFrames(
      options.fps,
      async (time, first) => {
        await draw();
        return video.add(time, 1 / options.fps, { keyFrame: first });
      },
      () => !failed,
    );
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  }
  return {
    async stop() {
      try {
        await stopFrames();
        if (failed) throw failed;
        await output.finalize();
        if (failed) throw failed;
        if (!target.buffer?.byteLength) throw new Error("Video recording produced no frames");
        return new Blob([target.buffer], { type: output.format.mimeType });
      } catch (error) {
        await output.cancel().catch(() => {});
        throw error;
      }
    },
  };
}

export function beginStreamEncoding(stream: MediaStream, options: StageVideoOptions): StageEncoding {
  if (options.container === "mov" || options.container === "gif" || options.container === "apng")
    throw new Error("Video recording unavailable");
  const formats =
    options.container === "mp4"
      ? ["video/mp4"]
      : [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
          ...(options.container ? [] : ["video/mp4"]),
        ];
  const mimeType = formats.find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error("Video recording unavailable");
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: videoBitrate(options.height),
    audioBitsPerSecond: 192_000,
  });
  const chunks: Blob[] = [];
  let failed: Error | undefined;
  let bytes = 0;
  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data.size || failed) return;
    bytes += event.data.size;
    if (bytes > maximumBytes) {
      failed = new Error("Recording size limit reached");
      if (recorder.state !== "inactive") recorder.stop();
    } else chunks.push(event.data);
  });
  recorder.addEventListener("error", () => {
    failed = new Error("Video recording failed");
    if (recorder.state !== "inactive") recorder.stop();
  });
  const start = performance.now();
  recorder.start(500);
  return {
    async stop() {
      if (recorder.state !== "inactive") {
        await new Promise<void>((resolve) => {
          recorder.addEventListener("stop", () => resolve(), { once: true });
          recorder.stop();
        });
      }
      if (failed) throw failed;
      const result = new Blob(chunks, { type: recorder.mimeType });
      chunks.length = 0;
      if (!result.size) throw new Error("Video recording produced no frames");
      return result.type.includes("webm") ? finalizeRecordingWebM(result, performance.now() - start) : result;
    },
  };
}
