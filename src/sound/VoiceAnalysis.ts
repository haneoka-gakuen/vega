export interface VegaVoiceSpectrumFrame {
  readonly rms: number;
  /** Normalized spectral centroid in the 0..5 kHz speech band. */
  readonly centroid: number;
  readonly low: number;
  readonly mid: number;
  readonly high: number;
}

export interface VegaVoicePcmFrame {
  readonly sourceKey: number | string;
  /** A read-only view over decoded mono PCM owned by the audio backend. */
  readonly channelData: Float32Array;
  readonly sampleRate: number;
  readonly samplePosition: number;
}

export type VegaViseme = "silence" | "a" | "i" | "u" | "e" | "o";

export interface VegaVisemeFrame {
  readonly sourceKey?: number | string;
  readonly sampleRate?: number;
  readonly samplePosition?: number;
  readonly rms: number;
  readonly dominant: VegaViseme;
  readonly weights: Readonly<Record<VegaViseme, number>>;
}

export interface VegaVoiceAnalyzer {
  sampleRms(): number;
  sampleSpectrum(): VegaVoiceSpectrumFrame | null;
  samplePcm(): VegaVoicePcmFrame | null;
  sampleViseme?(): VegaVisemeFrame | null;
  /**
   * Compatibility alias used by older host adapters. New integrations should
   * call `samplePcm`.
   */
  sampleMotionSyncPcm?(): VegaVoicePcmFrame | null;
  dispose(): void;
}

/**
 * Structural playback handle passed to scene backends. The legacy Howler
 * fields remain optional so existing host adapters can migrate incrementally.
 */
export interface VegaVoiceAnalysisSource {
  readonly playId?: number;
  readonly analyzer: VegaVoiceAnalyzer | null;
  readonly playbackStarted?: boolean;
  readonly playbackSettled?: boolean;
  readonly isPlaying?: () => boolean;
  readonly howl?: { playing(id?: number): boolean };
  readonly howlId?: number;
}

/** A deterministic, SDK-independent fallback useful to 2D and 3D adapters. */
export const estimateVegaVisemeFrame = (
  spectrum: VegaVoiceSpectrumFrame,
  pcm?: VegaVoicePcmFrame | null,
): VegaVisemeFrame => {
  const rms = clamp01(spectrum.rms);
  if (rms < 0.008) {
    return Object.freeze({
      ...(pcm ? pcmPosition(pcm) : {}),
      rms,
      dominant: "silence",
      weights: frozenWeights({ silence: 1, a: 0, i: 0, u: 0, e: 0, o: 0 }),
    });
  }

  const low = clamp01(spectrum.low);
  const mid = clamp01(spectrum.mid);
  const high = clamp01(spectrum.high);
  const centroid = clamp01(spectrum.centroid);
  const openness = clamp01((rms - 0.008) / 0.16);
  const raw = {
    silence: clamp01(1 - openness * 1.8),
    a: openness * (0.45 + mid * 0.75 + (1 - Math.abs(centroid - 0.42)) * 0.25),
    i: openness * (0.12 + high * 0.9 + centroid * 0.55),
    u: openness * (0.18 + low * 0.85 + (1 - centroid) * 0.3),
    e: openness * (0.2 + mid * 0.65 + high * 0.45),
    o: openness * (0.25 + low * 0.75 + mid * 0.25),
  };
  const total = Math.max(0.000001, Object.values(raw).reduce((sum, value) => sum + value, 0));
  const weights = frozenWeights({
    silence: raw.silence / total,
    a: raw.a / total,
    i: raw.i / total,
    u: raw.u / total,
    e: raw.e / total,
    o: raw.o / total,
  });
  const dominant = (Object.entries(weights) as [VegaViseme, number][]).reduce(
    (best, current) => (current[1] > best[1] ? current : best),
  )[0];
  return Object.freeze({
    ...(pcm ? pcmPosition(pcm) : {}),
    rms,
    dominant,
    weights,
  });
};

const pcmPosition = (pcm: VegaVoicePcmFrame) => ({
  sourceKey: pcm.sourceKey,
  sampleRate: pcm.sampleRate,
  samplePosition: pcm.samplePosition,
});

const frozenWeights = (
  weights: Record<VegaViseme, number>,
): Readonly<Record<VegaViseme, number>> => Object.freeze(weights);

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** @deprecated Use `VegaVoiceAnalyzer`. */
export type AdvVoiceAnalyzer = VegaVoiceAnalyzer;
/** @deprecated Use `VegaVoiceSpectrumFrame`. */
export type AdvVoiceSpectrumSample = VegaVoiceSpectrumFrame;
/** @deprecated Use `VegaVoicePcmFrame`. */
export type AdvVoicePcmSnapshot = VegaVoicePcmFrame;
