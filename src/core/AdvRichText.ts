export interface AdvRichTextTextNode {
  readonly type: "text";
  readonly value: string;
}

export interface AdvRichTextBreakNode {
  readonly type: "break";
}

export interface AdvRichTextSizeNode {
  readonly type: "size";
  readonly percent: number;
  readonly children: AdvRichTextNode[];
}

export interface AdvRichTextRubyNode {
  readonly type: "ruby";
  readonly base: string;
  readonly annotation: string;
}

export type AdvRichTextNode = AdvRichTextTextNode | AdvRichTextBreakNode | AdvRichTextSizeNode | AdvRichTextRubyNode;

export function advTextSizePercent(value: unknown): number {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return 100;
  return Math.max(40, Math.min(300, percent));
}

function appendText(children: AdvRichTextNode[], value: string): void {
  if (!value) return;
  const previous = children[children.length - 1];
  if (previous?.type === "text") {
    children[children.length - 1] = { type: "text", value: previous.value + value };
    return;
  }
  children.push({ type: "text", value });
}

function appendPlainText(children: AdvRichTextNode[], value: string): void {
  let start = 0;
  for (const match of value.matchAll(/\r\n|\r|\n/g)) {
    const index = match.index;
    appendText(children, value.slice(start, index));
    children.push({ type: "break" });
    start = index + match[0].length;
  }
  appendText(children, value.slice(start));
}

interface AdvRichTextSizeFrame {
  readonly type: "size";
  readonly node: AdvRichTextSizeNode;
}

interface AdvRichTextRubyFrame {
  readonly type: "ruby";
  readonly annotation: string;
  readonly parent: AdvRichTextNode[];
  base: string;
}

type AdvRichTextFrame = AdvRichTextSizeFrame | AdvRichTextRubyFrame;

/**
 * Parses the small, supported subset of Unity ADV markup into inert render nodes.
 * Unknown complete tags are discarded like the game player, and incomplete tags
 * are withheld so typewriter playback never exposes a partial markup token.
 *
 * Source episodes commonly omit `</size>`. Known opening tags therefore remain
 * active through the end of the value. Crossed ruby/size tags are recovered at
 * the first incompatible boundary so later dialogue is never swallowed.
 */
export function parseAdvRichText(value: unknown): AdvRichTextNode[] {
  const source = String(value ?? "");
  const root: AdvRichTextNode[] = [];
  const frames: AdvRichTextFrame[] = [];
  let index = 0;

  const activeChildren = (): AdvRichTextNode[] => {
    for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex -= 1) {
      const frame = frames[frameIndex];
      if (frame?.type === "size") return frame.node.children;
    }
    return root;
  };

  const closeRuby = (): void => {
    const frame = frames.at(-1);
    if (frame?.type !== "ruby") return;
    frames.pop();
    if (frame.base) {
      frame.parent.push({
        type: "ruby",
        base: frame.base,
        annotation: frame.annotation,
      });
    }
  };

  const appendSourceText = (text: string): void => {
    const frame = frames.at(-1);
    if (frame?.type === "ruby") {
      frame.base += text;
      return;
    }
    appendPlainText(activeChildren(), text);
  };

  while (index < source.length) {
    const rest = source.slice(index);
    const sizeOpen = rest.match(
      /^<size\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*%\s*>/iu,
    );
    if (sizeOpen) {
      closeRuby();
      const node: AdvRichTextSizeNode = {
        type: "size",
        percent: advTextSizePercent(sizeOpen[1]),
        children: [],
      };
      activeChildren().push(node);
      frames.push({ type: "size", node });
      index += sizeOpen[0].length;
      continue;
    }

    const sizeClose = rest.match(/^<\/size\s*>/iu);
    if (sizeClose) {
      closeRuby();
      let sizeIndex = -1;
      for (
        let frameIndex = frames.length - 1;
        frameIndex >= 0;
        frameIndex -= 1
      ) {
        if (frames[frameIndex]?.type === "size") {
          sizeIndex = frameIndex;
          break;
        }
      }
      if (sizeIndex >= 0) frames.splice(sizeIndex);
      index += sizeClose[0].length;
      continue;
    }

    const rubyOpen = rest.match(/^<ruby\s*=\s*([^>]*)>/iu);
    if (rubyOpen) {
      closeRuby();
      frames.push({
        type: "ruby",
        annotation: rubyOpen[1] || "",
        parent: activeChildren(),
        base: "",
      });
      index += rubyOpen[0].length;
      continue;
    }

    const rubyClose = rest.match(/^<\/ruby\s*>/iu);
    if (rubyClose) {
      closeRuby();
      index += rubyClose[0].length;
      continue;
    }

    if (source[index] === "<") {
      const tagEnd = source.indexOf(">", index);
      if (tagEnd < 0) break;
      index = tagEnd + 1;
      continue;
    }

    const nextTag = source.indexOf("<", index);
    const end = nextTag >= 0 ? nextTag : source.length;
    appendSourceText(source.slice(index, end));
    index = end;
  }

  closeRuby();
  return root;
}
