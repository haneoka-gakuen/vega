import type { AdvPlayer } from "../core/AdvPlayer";

export interface StageCaption {
  speaker: string;
  text: string;
}

const plain = (value: string) => value.replace(/<[^>]*>/gu, "").trim();

export function currentStageCaption(player: AdvPlayer, fullText = false): StageCaption | undefined {
  const { subtitles, chat, talk } = player.state;
  if (subtitles.visible && subtitles.text) return { text: plain(subtitles.text), speaker: "" };
  if (chat.visible) {
    const message = chat.messages.at(-1);
    if (message?.text) return { text: plain(message.text), speaker: plain(message.speaker) };
  }
  if (talk.enabled && talk.visible) {
    const text = plain(fullText ? talk.text : (talk.displayedText ?? talk.text));
    if (text) return { text, speaker: plain(talk.speaker) };
  }
  return undefined;
}

export function hasStageDialogue(player: AdvPlayer): boolean {
  const { subtitles, chat, talk } = player.state;
  return subtitles.visible || chat.visible || (talk.enabled && talk.visible);
}

export function stageSubtitleText(player: AdvPlayer): string {
  const caption = currentStageCaption(player, true);
  const primary = caption ? [caption.speaker, caption.text].filter(Boolean).join(": ") : "";
  return [primary, ...(player.SceneRoot.timelineSubtitleText?.() ?? [])].filter(Boolean).join("\n");
}

export async function paintStageDialogue(context: CanvasRenderingContext2D, player: AdvPlayer): Promise<void> {
  if (!hasStageDialogue(player)) return;
  if (await player.paintFrameDialogue?.(context)) return;
  const caption = currentStageCaption(player);
  if (caption) paintStageCaption(context, caption);
}

export function paintStageCaption(context: CanvasRenderingContext2D, caption: StageCaption): void {
  const { width, height } = context.canvas;
  const fontSize = Math.max(16, Math.round(Math.min(width, height) * 0.043));
  const lineHeight = fontSize * 1.36;
  const padding = fontSize * 0.7;
  const maxWidth = width * 0.86 - padding * 2;
  context.save();
  context.font = `${fontSize}px system-ui, sans-serif`;
  const lines: string[] = [];
  for (const paragraph of caption.text.split(/\r?\n/u)) {
    let line = "";
    const tokens = paragraph.match(
      /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\s+|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu,
    );
    for (const token of tokens ?? []) {
      if (line && context.measureText(line + token).width > maxWidth) {
        lines.push(line.trimEnd());
        line = token.trimStart();
      } else line += token;
    }
    lines.push(line.trimEnd());
  }
  const visible = lines.slice(-5);
  const speakerHeight = caption.speaker ? lineHeight * 0.8 : 0;
  const boxHeight = visible.length * lineHeight + speakerHeight + padding * 2;
  const top = height * 0.94 - boxHeight;
  const left = (width - maxWidth) / 2 - padding;
  context.fillStyle = "rgba(14, 10, 23, 0.82)";
  context.beginPath();
  context.roundRect(left, top, maxWidth + padding * 2, boxHeight, padding * 0.7);
  context.fill();
  context.textAlign = "left";
  context.textBaseline = "top";
  if (caption.speaker) {
    context.font = `600 ${fontSize * 0.76}px system-ui, sans-serif`;
    context.fillStyle = "#e8d4ff";
    context.fillText(caption.speaker, left + padding, top + padding, maxWidth);
  }
  context.font = `${fontSize}px system-ui, sans-serif`;
  context.fillStyle = "#ffffff";
  visible.forEach((line, index) =>
    context.fillText(line, left + padding, top + padding + speakerHeight + index * lineHeight, maxWidth),
  );
  context.restore();
}

export async function addStageCaptionToImage(
  source: string,
  format: "image/png" | "image/jpeg" | "image/webp",
  player: AdvPlayer,
): Promise<string> {
  const image = new Image();
  image.src = source;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Stage capture is unavailable");
  context.drawImage(image, 0, 0);
  await paintStageDialogue(context, player);
  return canvas.toDataURL(format, 0.92);
}
