type Element = { id: number; start: number; body: number; end: number; unknown: boolean };
function element(bytes: Uint8Array, start: number): Element {
  let width = 1;
  while (width <= 4 && !(bytes[start]! & (128 >> (width - 1)))) width++;
  if (width > 4) throw new Error("Invalid WebM element");
  let id = 0;
  for (let index = 0; index < width; index++) id = id * 256 + bytes[start + index]!;
  const sizeAt = start + width;
  let length = 1;
  while (length <= 8 && !(bytes[sizeAt]! & (128 >> (length - 1)))) length++;
  if (length > 8 || sizeAt + length > bytes.length) throw new Error("Invalid WebM element size");
  let size = BigInt(bytes[sizeAt]! & ((128 >> (length - 1)) - 1));
  for (let index = 1; index < length; index++) size = size * 256n + BigInt(bytes[sizeAt + index]!);
  const unknown = size === (1n << BigInt(length * 7)) - 1n,
    body = sizeAt + length;
  return { id, start, body, end: unknown ? bytes.length : body + Number(size), unknown };
}
function sizeBytes(size: number): Uint8Array<ArrayBuffer> {
  let length = 1;
  while (BigInt(size) >= (1n << BigInt(length * 7)) - 1n) length++;
  const bytes = new Uint8Array(length);
  let value = BigInt(size);
  for (let index = length - 1; index >= 0; index--) {
    bytes[index] = Number(value & 255n);
    value >>= 8n;
  }
  bytes[0]! |= 128 >> (length - 1);
  return bytes;
}

/** Finalize the duration of streaming MediaRecorder WebM without re-encoding media. */
export async function finalizeRecordingWebM(blob: Blob, durationMs: number): Promise<Blob> {
  const bytes = new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer());
  const header = element(bytes, 0),
    segment = element(bytes, header.end);
  if (header.id !== 0x1a45dfa3 || segment.id !== 0x18538067 || !segment.unknown) return blob;
  let info: Element | undefined, cluster: Element | undefined;
  for (let at = segment.body; at < bytes.length;) {
    const value = element(bytes, at);
    if (value.id === 0x114d9b74) return blob;
    if (value.id === 0x1549a966) info = value;
    if (value.id === 0x1f43b675) {
      cluster = value;
      break;
    }
    if (value.unknown || value.end <= at) return blob;
    at = value.end;
  }
  if (!info || !cluster || info.end > bytes.length) return blob;
  let scale = 1_000_000;
  const children: Uint8Array<ArrayBuffer>[] = [];
  for (let at = info.body; at < info.end;) {
    const value = element(bytes, at);
    if (value.end > info.end || value.end <= at) return blob;
    if (value.id === 0x2ad7b1) {
      scale = 0;
      for (const byte of bytes.subarray(value.body, value.end)) scale = scale * 256 + byte;
    }
    if (value.id !== 0x4489 && value.id !== 0xbf) children.push(bytes.slice(value.start, value.end));
    at = value.end;
  }
  const duration = new Uint8Array(11);
  duration.set([0x44, 0x89, 0x88]);
  new DataView(duration.buffer).setFloat64(3, (durationMs * 1_000_000) / scale);
  children.push(duration);
  const length = children.reduce((size, child) => size + child.length, 0);
  return new Blob(
    [
      bytes.slice(0, info.start),
      bytes.slice(info.start, info.start + 4),
      sizeBytes(length),
      ...children,
      blob.slice(info.end),
    ],
    { type: blob.type },
  );
}
