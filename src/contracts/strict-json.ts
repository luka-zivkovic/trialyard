/** Parse JSON without losing duplicate keys, invalid UTF-8, or numeric overflow. */
export function parseJson(bytes: Uint8Array | string, maxBytes = 2 * 1024 * 1024): unknown {
  if (Buffer.byteLength(bytes) > maxBytes) throw new Error("JSON byte limit exceeded");
  const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let i = 0;
  const fail = (message: string): never => { throw new Error(`${message} at JSON offset ${i}`); };
  const whitespace = () => { while (i < text.length && /[\t\n\r ]/.test(text[i]!)) i++; };
  const string = (): string => {
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') return JSON.parse(text.slice(start, i)) as string;
      if (c === "\\") i++;
    }
    return fail("Unterminated string");
  };
  const value = (depth: number): void => {
    if (depth > 64) fail("JSON nesting limit exceeded");
    whitespace();
    const c = text[i];
    if (c === '"') { string(); return; }
    if (c === "{") {
      i++; whitespace();
      const keys = new Set<string>();
      if (text[i] === "}") { i++; return; }
      while (i < text.length) {
        whitespace();
        if (text[i] !== '"') fail("Expected object key");
        const key = string();
        if (keys.has(key)) fail("Duplicate object key");
        keys.add(key); whitespace();
        if (text[i++] !== ":") fail("Expected colon");
        value(depth + 1); whitespace();
        if (text[i] === "}") { i++; return; }
        if (text[i++] !== ",") fail("Expected comma");
      }
      fail("Unterminated object");
    }
    if (c === "[") {
      i++; whitespace();
      if (text[i] === "]") { i++; return; }
      while (i < text.length) {
        value(depth + 1); whitespace();
        if (text[i] === "]") { i++; return; }
        if (text[i++] !== ",") fail("Expected comma");
      }
      fail("Unterminated array");
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, i)) { i += literal.length; return; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (!number) fail("Expected JSON value");
    if (!Number.isFinite(Number(number![0]))) fail("Nonfinite number");
    i += number![0].length;
  };
  value(0); whitespace();
  if (i !== text.length) fail("Trailing JSON data");
  return JSON.parse(text) as unknown;
}
