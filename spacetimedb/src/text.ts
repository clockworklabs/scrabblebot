// String helpers with Rust's semantics, so validation and limits behave
// exactly as they did when the module was written in Rust.

const encoder = new TextEncoder();

// Length in UTF-8 bytes, like Rust's `str::len`.
export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

// Uppercases a-z only, like Rust's `str::to_ascii_uppercase`.
export function asciiUppercase(s: string): string {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}

export function isAsciiUppercase(s: string): boolean {
  return /^[A-Z]*$/.test(s);
}

// Unicode White_Space, which is what Rust's `str::trim` strips. JS's
// `String.prototype.trim` differs slightly (it strips U+FEFF but not U+0085).
const WHITE_SPACE =
  "[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const TRIM = new RegExp(`^${WHITE_SPACE}+|${WHITE_SPACE}+$`, "g");

export function trim(s: string): string {
  return s.replace(TRIM, "");
}
