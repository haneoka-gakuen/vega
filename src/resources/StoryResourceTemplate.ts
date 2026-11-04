const tokens = () => /(?<!\\)(?:\{\{[\s\S]*?\}\}|\{[A-Za-z_$\p{L}][\w$.\p{L}\p{N}]*\})/gu;

export const decodeStoryResourceTemplate = (source: string): string => /%7[bd]/iu.test(source) ? decodeURI(source) : source;

export const isStoryResourceTemplate = (source: string): boolean => tokens().test(decodeStoryResourceTemplate(source));

export function storyResourceTemplatePattern(source: string): RegExp | undefined {
  const value = decodeStoryResourceTemplate(source);
  const matches = [...value.matchAll(tokens())];
  if (!matches.length) return;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  let expression = "^", offset = 0;
  for (const match of matches) {
    expression += escape(value.slice(offset, match.index)) + ".+";
    offset = match.index + match[0].length;
  }
  return new RegExp(expression + escape(value.slice(offset)) + "$", "u");
}

export function scopedStoryResourceTemplate(source: string, root: string): string {
  const value = decodeStoryResourceTemplate(source).replace(/^\.\//u, "");
  const encoded = value.split("/").map((segment) => {
    let output = "", offset = 0;
    for (const match of segment.matchAll(tokens())) {
      output += encodeURIComponent(segment.slice(offset, match.index)) + match[0];
      offset = match.index + match[0].length;
    }
    return output + encodeURIComponent(segment.slice(offset));
  }).join("/");
  return root.replace(/\/?$/u, "/") + encoded;
}
