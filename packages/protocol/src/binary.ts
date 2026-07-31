import { decode, encode } from "@msgpack/msgpack";
import type { VegaBundle } from "./model.js";

const MAGIC = Uint8Array.from([0x56, 0x45, 0x47, 0x41, 0x42, 0x01, 0x0d, 0x0a]);

export const VEGA_BINARY_MEDIA_TYPE = "application/vnd.haneoka.vega-bundle";
export const VEGA_BINARY_EXTENSION = ".vgb";

export const encodeVegaBundle = (bundle: VegaBundle): Uint8Array => {
  const payload = encode(bundle, { sortKeys: true, ignoreUndefined: true });
  const output = new Uint8Array(MAGIC.length + payload.length);
  output.set(MAGIC);
  output.set(payload, MAGIC.length);
  return output;
};

export const decodeVegaBundle = (bytes: Uint8Array): VegaBundle => {
  if (bytes.length <= MAGIC.length || !MAGIC.every((value, index) => bytes[index] === value)) {
    throw new TypeError("Invalid Vega binary bundle header");
  }
  const value = decode(bytes.subarray(MAGIC.length));
  assertVegaBundle(value);
  return value;
};

export const isVegaBinaryBundle = (bytes: Uint8Array): boolean =>
  bytes.length > MAGIC.length && MAGIC.every((value, index) => bytes[index] === value);

function assertVegaBundle(value: unknown): asserts value is VegaBundle {
  if (!value || typeof value !== "object") throw new TypeError("Vega bundle must be an object");
  const bundle = value as Partial<VegaBundle>;
  if (bundle.format !== "vega-bundle" || bundle.formatVersion !== 1) {
    throw new TypeError("Unsupported Vega bundle format");
  }
  if (!bundle.project || bundle.project.format !== "vega-project") {
    throw new TypeError("Vega bundle has no valid project");
  }
}
