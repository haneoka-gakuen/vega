import { ALL_FORMATS, AudioBufferSink, BufferSource, Input } from "mediabunny";

export async function decodeStoryVideoAudio(
  bytes: Uint8Array,
  context: BaseAudioContext,
  signal?: AbortSignal,
): Promise<AudioBuffer | undefined> {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return;
    if (!(await track.canDecode())) throw new Error("The video audio cannot be decoded");
    const chunks = [];
    let end = 0;
    for await (const chunk of new AudioBufferSink(track).buffers()) {
      signal?.throwIfAborted();
      chunks.push(chunk);
      end = Math.max(end, chunk.timestamp + chunk.duration);
      if (end * chunk.buffer.sampleRate * chunk.buffer.numberOfChannels * 4 > 256 * 1024 * 1024)
        throw new Error("Recording size limit reached");
    }
    const first = chunks[0]?.buffer;
    if (!first || !end) return;
    const decoded = context.createBuffer(first.numberOfChannels, Math.ceil(end * first.sampleRate), first.sampleRate);
    for (const { buffer, timestamp } of chunks) {
      const start = Math.round(timestamp * first.sampleRate);
      for (let channel = 0; channel < first.numberOfChannels; channel++) {
        decoded
          .getChannelData(channel)
          .set(
            buffer
              .getChannelData(channel)
              .subarray(Math.max(0, -start), Math.min(buffer.length, decoded.length - start)),
            Math.max(start, 0),
          );
      }
    }
    return decoded;
  } finally {
    input.dispose();
  }
}
