import { createHash } from "node:crypto";

import { canonicalize } from "./canonical.js";
import type { Payload } from "./types.js";

const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Hash the exact bytes represented by a transcript line, including its ending. */
export const lineHash = (rawLine: string | Uint8Array): string => {
  const bytes = typeof rawLine === "string" ? new TextEncoder().encode(rawLine) : rawLine;
  return sha256(bytes);
};

/**
 * Split raw transcript bytes into physical lines, each including its own terminator (SCHEMA
 * §7: a provenance line hash covers the raw bytes, terminator included). A final line with no
 * trailing `\n` is still returned, terminator-less — SCHEMA §7's "still a line" rule.
 */
export function splitPhysicalLines(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    lines.push(bytes.slice(start, index + 1));
    start = index + 1;
  }
  if (start < bytes.length) lines.push(bytes.slice(start));
  return lines;
}

/** Hash only the canonical payload; envelope fields are intentionally excluded. */
export const payloadHash = (payload: Payload): string =>
  sha256(new TextEncoder().encode(canonicalize(payload)));
