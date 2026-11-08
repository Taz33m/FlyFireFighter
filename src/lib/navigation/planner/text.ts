/**
 * Plain-text helpers for application-generated descriptions and for screening untrusted text.
 * Lengths are UTF-16 code units, matching the boundary schemas.
 */

/** C0/C1 control characters and the Unicode line/paragraph separators. */
export function isControlCode(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

export function hasControlCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (isControlCode(text.charCodeAt(i))) return true;
  }
  return false;
}

/** Replace control characters with spaces, collapse whitespace, trim and bound the length. */
export function sanitizeText(text: string, maxLength: number): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += isControlCode(code) ? " " : text[i];
  }
  return clip(out.replace(/\s+/g, " ").trim(), maxLength);
}

/** Truncate with an ellipsis, never splitting a surrogate pair. */
export function clip(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = Math.max(0, maxLength - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Locale-independent comparison by UTF-16 code units. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Byte length of the UTF-8 encoding. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
