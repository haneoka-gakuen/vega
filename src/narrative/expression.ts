import type { VegaJsonValue } from "@haneoka/vega-protocol";

export type VegaExpressionScope = Readonly<Record<string, VegaJsonValue>>;

type TokenKind =
  | "number"
  | "string"
  | "identifier"
  | "operator"
  | "left-parenthesis"
  | "right-parenthesis"
  | "eof";

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly offset: number;
}

const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const IDENTIFIER_START = /[A-Za-z_$\p{L}]/u;
const IDENTIFIER_PART = /[\w$.\p{L}\p{N}]/u;
const MAX_EXPRESSION_LENGTH = 8_192;
const MAX_PARSE_DEPTH = 64;

export class VegaExpressionError extends SyntaxError {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "VegaExpressionError";
    this.offset = offset;
  }
}

export const evaluateVegaExpression = (
  source: string,
  scope: VegaExpressionScope,
): VegaJsonValue => {
  if (typeof source !== "string") throw new TypeError("Vega expression must be a string");
  if (source.length > MAX_EXPRESSION_LENGTH) {
    throw new VegaExpressionError(`Expression exceeds ${MAX_EXPRESSION_LENGTH} characters`, MAX_EXPRESSION_LENGTH);
  }
  const parser = new Parser(tokenize(source), scope);
  const value = parser.parseExpression();
  parser.expect("eof");
  return toJsonValue(value);
};

export const evaluateVegaCondition = (source: string, scope: VegaExpressionScope): boolean =>
  Boolean(evaluateVegaExpression(source, scope));

/**
 * Interpolates `{{ expression }}` and the WebGAL-compatible `{identifier}`
 * shorthand without executing JavaScript.
 */
export const interpolateVegaText = (text: string, scope: VegaExpressionScope): string =>
  String(text)
    .replace(/\{\{([\s\S]*?)\}\}/g, (_match, expression: string) =>
      stringifyExpressionValue(evaluateVegaExpression(expression.trim(), scope)),
    )
    .replace(/\{([A-Za-z_$\p{L}][\w$.\p{L}\p{N}]*)\}/gu, (_match, identifier: string) =>
      stringifyExpressionValue(resolveIdentifier(identifier, scope)),
    );

const stringifyExpressionValue = (value: VegaJsonValue | undefined): string => {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const resolveIdentifier = (identifier: string, scope: VegaExpressionScope): VegaJsonValue | undefined => {
  const parts = identifier.split(".");
  if (parts.some((part) => !part || BLOCKED_PATH_SEGMENTS.has(part))) return undefined;
  let value: unknown = scope;
  for (const part of parts) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, part)) {
      return undefined;
    }
    value = (value as Readonly<Record<string, unknown>>)[part];
  }
  return isJsonValue(value) ? value : undefined;
};

class Parser {
  private index = 0;
  private depth = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly scope: VegaExpressionScope,
  ) {}

  parseExpression(): unknown {
    return this.withDepth(() => this.parseOr());
  }

  expect(kind: TokenKind, value?: string): Token {
    const token = this.peek();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new VegaExpressionError(
        `Expected ${value === undefined ? kind : JSON.stringify(value)}, received ${JSON.stringify(token.value)}`,
        token.offset,
      );
    }
    this.index += 1;
    return token;
  }

  private parseOr(): unknown {
    let value = this.parseAnd();
    while (this.consumeOperator("||")) value = Boolean(value) || Boolean(this.parseAnd());
    return value;
  }

  private parseAnd(): unknown {
    let value = this.parseEquality();
    while (this.consumeOperator("&&")) value = Boolean(value) && Boolean(this.parseEquality());
    return value;
  }

  private parseEquality(): unknown {
    let value = this.parseComparison();
    for (;;) {
      if (this.consumeOperator("===") || this.consumeOperator("==")) value = jsonEquals(value, this.parseComparison());
      else if (this.consumeOperator("!==") || this.consumeOperator("!=")) {
        value = !jsonEquals(value, this.parseComparison());
      } else return value;
    }
  }

  private parseComparison(): unknown {
    let value = this.parseTerm();
    for (;;) {
      if (this.consumeOperator("<=")) value = compare(value, this.parseTerm()) <= 0;
      else if (this.consumeOperator(">=")) value = compare(value, this.parseTerm()) >= 0;
      else if (this.consumeOperator("<")) value = compare(value, this.parseTerm()) < 0;
      else if (this.consumeOperator(">")) value = compare(value, this.parseTerm()) > 0;
      else return value;
    }
  }

  private parseTerm(): unknown {
    let value = this.parseFactor();
    for (;;) {
      if (this.consumeOperator("+")) {
        const right = this.parseFactor();
        value =
          typeof value === "string" || typeof right === "string"
            ? `${value == null ? "" : String(value)}${right == null ? "" : String(right)}`
            : numeric(value) + numeric(right);
      } else if (this.consumeOperator("-")) value = numeric(value) - numeric(this.parseFactor());
      else return value;
    }
  }

  private parseFactor(): unknown {
    let value = this.parseUnary();
    for (;;) {
      if (this.consumeOperator("*")) value = numeric(value) * numeric(this.parseUnary());
      else if (this.consumeOperator("/")) {
        const divisor = numeric(this.parseUnary());
        if (divisor === 0) throw new VegaExpressionError("Division by zero", this.previous().offset);
        value = numeric(value) / divisor;
      } else if (this.consumeOperator("%")) {
        const divisor = numeric(this.parseUnary());
        if (divisor === 0) throw new VegaExpressionError("Division by zero", this.previous().offset);
        value = numeric(value) % divisor;
      } else return value;
    }
  }

  private parseUnary(): unknown {
    if (this.consumeOperator("!")) return !Boolean(this.parseUnary());
    if (this.consumeOperator("-")) return -numeric(this.parseUnary());
    if (this.consumeOperator("+")) return numeric(this.parseUnary());
    return this.parsePrimary();
  }

  private parsePrimary(): unknown {
    const token = this.peek();
    if (token.kind === "number") {
      this.index += 1;
      return Number(token.value);
    }
    if (token.kind === "string") {
      this.index += 1;
      return token.value;
    }
    if (token.kind === "identifier") {
      this.index += 1;
      if (token.value === "true") return true;
      if (token.value === "false") return false;
      if (token.value === "null") return null;
      return resolveIdentifier(token.value, this.scope);
    }
    if (token.kind === "left-parenthesis") {
      this.index += 1;
      const value = this.parseExpression();
      this.expect("right-parenthesis");
      return value;
    }
    throw new VegaExpressionError(`Unexpected token ${JSON.stringify(token.value)}`, token.offset);
  }

  private withDepth<T>(operation: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_PARSE_DEPTH) {
      throw new VegaExpressionError(`Expression nesting exceeds ${MAX_PARSE_DEPTH}`, this.peek().offset);
    }
    try {
      return operation();
    } finally {
      this.depth -= 1;
    }
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.index - 1)]!;
  }

  private consumeOperator(value: string): boolean {
    const token = this.peek();
    if (token.kind !== "operator" || token.value !== value) return false;
    this.index += 1;
    return true;
  }
}

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "(" || character === ")") {
      tokens.push({
        kind: character === "(" ? "left-parenthesis" : "right-parenthesis",
        value: character,
        offset: index,
      });
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const start = index;
      const quote = character;
      let value = "";
      index += 1;
      let closed = false;
      while (index < source.length) {
        const current = source[index]!;
        if (current === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (current === "\\") {
          const escaped = source[index + 1];
          if (escaped === undefined) break;
          const escapes: Readonly<Record<string, string>> = {
            n: "\n",
            r: "\r",
            t: "\t",
            "\\": "\\",
            '"': '"',
            "'": "'",
          };
          value += escapes[escaped] ?? escaped;
          index += 2;
          continue;
        }
        value += current;
        index += 1;
      }
      if (!closed) throw new VegaExpressionError("Unterminated string", start);
      tokens.push({ kind: "string", value, offset: start });
      continue;
    }
    if (/[0-9]/u.test(character) || (character === "." && /[0-9]/u.test(source[index + 1] ?? ""))) {
      const start = index;
      const match = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u);
      if (!match) throw new VegaExpressionError("Invalid number", start);
      tokens.push({ kind: "number", value: match[0], offset: start });
      index += match[0].length;
      continue;
    }
    if (IDENTIFIER_START.test(character)) {
      const start = index;
      let value = character;
      index += 1;
      while (index < source.length && IDENTIFIER_PART.test(source[index]!)) {
        value += source[index]!;
        index += 1;
      }
      if (value.split(".").some((part) => !part || BLOCKED_PATH_SEGMENTS.has(part))) {
        throw new VegaExpressionError("Unsafe identifier", start);
      }
      tokens.push({ kind: "identifier", value, offset: start });
      continue;
    }
    const operator = ["===", "!==", "<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "!", "<", ">"].find(
      (candidate) => source.startsWith(candidate, index),
    );
    if (operator) {
      tokens.push({ kind: "operator", value: operator, offset: index });
      index += operator.length;
      continue;
    }
    throw new VegaExpressionError(`Unexpected character ${JSON.stringify(character)}`, index);
  }
  tokens.push({ kind: "eof", value: "", offset: source.length });
  return tokens;
};

const numeric = (value: unknown): number => {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new TypeError(`Expected a finite number, received ${String(value)}`);
  return result;
};

const compare = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
};

const jsonEquals = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (!isJsonValue(left) || !isJsonValue(right)) return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

const isJsonValue = (value: unknown): value is VegaJsonValue => {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.entries(value).every(([key, entry]) => !BLOCKED_PATH_SEGMENTS.has(key) && isJsonValue(entry))
  );
};

const toJsonValue = (value: unknown): VegaJsonValue => {
  if (value === undefined) return null;
  if (!isJsonValue(value)) throw new TypeError("Expression result is not a JSON value");
  return value;
};
