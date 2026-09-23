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

export interface AdvRichTextStyleNode {
  readonly type: "style";
  readonly style: Readonly<
    Partial<
      Record<
        "fontWeight" | "fontStyle" | "textDecoration" | "whiteSpace" | "color" | "fontSize" | "position" | "top",
        string
      >
    >
  >;
  readonly children: AdvRichTextNode[];
}

export interface AdvRichTextSpaceNode {
  readonly type: "space";
  readonly value: number;
  readonly unit: "px" | "em" | "%";
}

export type AdvRichTextNode =
  | AdvRichTextTextNode
  | AdvRichTextBreakNode
  | AdvRichTextSizeNode
  | AdvRichTextRubyNode
  | AdvRichTextStyleNode
  | AdvRichTextSpaceNode;

export function advTextSizePercent(value: unknown): number {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return 100;
  return Math.max(0, percent);
}

function appendText(children: AdvRichTextNode[], value: string): void {
  if (!value) return;
  const previous = children[children.length - 1];
  if (previous?.type === "text") {
    children[children.length - 1] = {
      type: "text",
      value: previous.value + value,
    };
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

interface AdvRichTextStyleFrame {
  readonly type: "style";
  readonly tag: string;
  readonly node: AdvRichTextStyleNode;
}
type AdvRichTextFrame = AdvRichTextSizeFrame | AdvRichTextRubyFrame | AdvRichTextStyleFrame;

const parseLength = (source: string): { value: number; unit: "px" | "em" | "%" } | null => {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|em|%)?$/iu.exec(source.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? { value, unit: (match[2]?.toLowerCase() || "px") as "px" | "em" | "%" } : null;
};

export const advTextLengthCss = (value: number, unit: "px" | "em" | "%"): string =>
  unit === "px" ? `calc(${value} * var(--vega-adv-pixel, 1px))` : `${value}${unit}`;

/**
 * Parses supported ADV markup into inert render nodes.
 * Unknown complete tags are discarded, and incomplete tags
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
      if (frame?.type === "size" || frame?.type === "style") return frame.node.children;
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
    const control =
      /^<(\/)?(b|i|u|s|nobr|color|voffset|space|br|noparse|size)(?:\s*=\s*("[^"]*"|'[^']*'|[^>]*))?\s*>/iu.exec(rest);
    if (control) {
      const closing = Boolean(control[1]);
      const tag = control[2].toLowerCase();
      const argument = (control[3] || "")
        .trim()
        .replace(/^(?:"(.*)"|'(.*)')$/u, (_match, double, single) => double ?? single);
      const length = parseLength(argument);
      let style: AdvRichTextStyleNode["style"] | undefined;
      if (!closing && tag === "noparse") {
        const end = source.toLowerCase().indexOf("</noparse>", index + control[0].length);
        appendSourceText(source.slice(index + control[0].length, end < 0 ? source.length : end));
        index = end < 0 ? source.length : end + "</noparse>".length;
        continue;
      }
      if (!closing && tag === "br") {
        appendSourceText("\n");
        index += control[0].length;
        continue;
      }
      if (!closing && tag === "space" && length) {
        closeRuby();
        activeChildren().push({ type: "space", ...length });
        index += control[0].length;
        continue;
      }
      if (!closing && tag === "size" && length?.unit === "%" && length.value >= 0) {
        closeRuby();
        const node: AdvRichTextSizeNode = {
          type: "size",
          percent: length.value,
          children: [],
        };
        activeChildren().push(node);
        frames.push({ type: "size", node });
        index += control[0].length;
        continue;
      }
      if (!closing) {
        if (tag === "b") style = { fontWeight: "700" };
        else if (tag === "i") style = { fontStyle: "italic" };
        else if (tag === "u") style = { textDecoration: "underline" };
        else if (tag === "s") style = { textDecoration: "line-through" };
        else if (tag === "nobr") style = { whiteSpace: "nowrap" };
        else if (
          tag === "color" &&
          /^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|black|white|red|green|blue|yellow|orange|purple|cyan|magenta|grey|gray|transparent)$/iu.test(
            argument,
          )
        )
          style = { color: argument };
        else if (tag === "voffset" && length)
          style = {
            position: "relative",
            top: advTextLengthCss(
              length.unit === "%" ? -length.value / 100 : -length.value,
              length.unit === "%" ? "em" : length.unit,
            ),
          };
        else if (tag === "size" && length && length.unit === "px" && /^[+-]/u.test(argument))
          style = {
            fontSize: `calc(1em + ${advTextLengthCss(length.value, length.unit)})`,
          };
        else if (tag === "size" && length && length.unit !== "%" && length.value >= 0)
          style = { fontSize: advTextLengthCss(length.value, length.unit) };
      }
      if (style) {
        closeRuby();
        const node: AdvRichTextStyleNode = {
          type: "style",
          style,
          children: [],
        };
        activeChildren().push(node);
        frames.push({ type: "style", tag, node });
        index += control[0].length;
        continue;
      }
      if (closing && tag !== "size") {
        closeRuby();
        let frameIndex = -1;
        for (let i = frames.length - 1; i >= 0; i--) {
          const frame = frames[i];
          if (frame.type === "style" && frame.tag === tag) {
            frameIndex = i;
            break;
          }
        }
        if (frameIndex >= 0) frames.splice(frameIndex);
        index += control[0].length;
        continue;
      }
    }
    const sizeOpen = rest.match(/^<size\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*%\s*>/iu);
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
      for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex -= 1) {
        const frame = frames[frameIndex];
        if (frame?.type === "size" || (frame?.type === "style" && frame.tag === "size")) {
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
