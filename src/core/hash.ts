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

/** Hash only the canonical payload; envelope fields are intentionally excluded. */
export const payloadHash = (payload: Payload): string =>
  sha256(new TextEncoder().encode(canonicalize(payload)));
