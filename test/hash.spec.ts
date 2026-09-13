import { describe, expect, it } from "vitest";

import { lineHash, payloadHash } from "../src/core/hash.js";
import type { Payload } from "../src/core/types.js";

const payload = (): Payload => ({
  facts: [],
  counters: {
    facts: 0,
    by_kind: {},
    source_entries: 0,
    source_tool_calls: 0,
    unmapped_tool_calls: 0,
    coverage_ppm: 0,
    external_path_count: 0,
  },
  git: null,
  plan: null,
  path_base: "repo",
  version: 1,
});

describe("hash primitives", () => {
  it("returns a lowercase SHA-256 payload hash", () => {
    expect(payloadHash(payload())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("hashes the canonical payload and excludes no payload fields", () => {
    const first = payload();
    const second = { ...first, path_base: "cwd" as const };
    expect(payloadHash(first)).not.toBe(payloadHash(second));
  });

  it("includes the exact supplied line ending", () => {
    const lf = lineHash("tool result\n");
    const crlf = lineHash("tool result\r\n");
    expect(lf).toBe("sha256:ee62f40645763a899cbe1a0e3c341085524355a30e6d1fc81f6419094fe71a92");
    expect(lf).not.toBe(crlf);
    expect(lineHash(new TextEncoder().encode("tool result\r\n"))).toBe(crlf);
  });
});
