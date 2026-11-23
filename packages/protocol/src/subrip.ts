export interface VegaSubtitleCue {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function subtitleTime(seconds: number): string {
  const value = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(value / 3600000)).padStart(2, "0")}:${String(Math.floor(value / 60000) % 60).padStart(2, "0")}:${String(Math.floor(value / 1000) % 60).padStart(2, "0")},${String(value % 1000).padStart(3, "0")}`;
}

export function formatVegaSubRip(cues: readonly VegaSubtitleCue[]): string {
  return cues
    .filter((cue) => cue.text.trim() && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
    .sort((a, b) => a.start - b.start)
    .map((cue, index) => `${index + 1}\n${subtitleTime(cue.start)} --> ${subtitleTime(cue.end)}\n${cue.text}\n`)
    .join("\n");
}
