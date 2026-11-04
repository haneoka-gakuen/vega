import type { AdvPlayer } from "../core/AdvPlayer";
import { finalizeRecordingWebM } from "./recordingWebM";

const subtitleTime = (seconds: number): string => {
  const value = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(value / 3600000)).padStart(2, "0")}:${String(Math.floor(value / 60000) % 60).padStart(2, "0")}:${String(Math.floor(value / 1000) % 60).padStart(2, "0")},${String(value % 1000).padStart(3, "0")}`;
};

/** Records the selected native backend and this player's audio bus. */
export class StageRecording {
  private readonly recorder: MediaRecorder;
  private readonly chunks: Blob[] = [];
  private readonly capture: { stream: MediaStream; dispose(): void };
  private readonly startedAt = performance.now();
  private readonly cues: { text: string; start: number; end: number }[] = [];
  private timer: ReturnType<typeof setInterval>;
  private result?: Blob;
  private failure?: Error;
  private bytes = 0;
  private stopping?: Promise<Blob>;
  constructor(
    private readonly player: AdvPlayer,
    options: { width: number; height: number; fps: number },
  ) {
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find(
      (type) => MediaRecorder.isTypeSupported(type),
    );
    if (!mimeType || !player.SceneRoot.createVideoCapture) throw new Error("Video recording unavailable");
    this.capture = player.SceneRoot.createVideoCapture(options);
    try {
      const audio = player.SoundManager.beginAudioCapture();
      const stream = new MediaStream([...this.capture.stream.getVideoTracks(), ...audio.getAudioTracks()]);
      this.recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: options.height >= 1080 ? 10_000_000 : 6_000_000,
        audioBitsPerSecond: 192000,
      });
      this.recorder.addEventListener("dataavailable", (event) => {
        if (!event.data.size) return;
        this.bytes += event.data.size;
        if (this.bytes > 512 * 1024 * 1024) {
          this.failure = new Error("Recording size limit reached");
          void this.stop().catch(() => {});
        } else this.chunks.push(event.data);
      });
      this.recorder.addEventListener("error", () => {
        this.failure = new Error("Video recording failed");
        void this.stop().catch(() => {});
      });
      this.recorder.start(500);
    } catch (error) {
      this.capture.dispose();
      player.SoundManager.endAudioCapture();
      throw error;
    }
    this.timer = setInterval(() => this.subtitle(), 40);
    this.subtitle();
  }
  private subtitle(): void {
    const talk = this.player.state.talk;
    const text = talk.visible ? [talk.speaker, talk.text].filter(Boolean).join(": ").replace(/\r?\n/gu, "\n") : "";
    const time = (performance.now() - this.startedAt) / 1000,
      previous = this.cues.at(-1);
    if (previous?.text === text) {
      previous.end = time;
      return;
    }
    if (previous) previous.end = time;
    this.cues.push({ text, start: time, end: time });
  }
  stop(): Promise<Blob> {
    if (this.stopping) return this.stopping;
    this.stopping = new Promise<Blob>((resolve, reject) => {
      const finish = async () => {
        clearInterval(this.timer);
        this.subtitle();
        this.capture.dispose();
        this.player.SoundManager.endAudioCapture();
        this.result = new Blob(this.chunks, { type: this.recorder.mimeType });
        this.chunks.length = 0;
        try {
          if (this.result.type.includes("webm"))
            this.result = await finalizeRecordingWebM(this.result, performance.now() - this.startedAt);
          if (this.failure) reject(this.failure);
          else resolve(this.result);
        } catch (error) {
          reject(error);
        }
      };
      this.recorder.addEventListener("stop", finish, { once: true });
      if (this.recorder.state === "inactive") finish();
      else this.recorder.stop();
    });
    return this.stopping;
  }
  get subtitles(): string {
    return this.cues
      .filter((cue) => cue.text && cue.end > cue.start)
      .map((cue, index) => `${index + 1}\n${subtitleTime(cue.start)} --> ${subtitleTime(cue.end)}\n${cue.text}\n`)
      .join("\n");
  }
  async read(offset: number): Promise<string> {
    if (!this.result) throw new Error("Recording is still running");
    const bytes = new Uint8Array(await this.result.slice(offset, offset + 192 * 1024).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  async dispose(): Promise<void> {
    await this.stop().catch(() => {});
    this.result = undefined;
    this.cues.length = 0;
  }
}
