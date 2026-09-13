import { describe, expect, it } from "vitest";

import { extractFacts, extractPayload } from "../src/core/extract/index.js";
import { payloadHash } from "../src/core/hash.js";
import type { ExtractConfig, NormalizedEvent, NormalizedToolEvent } from "../src/core/types.js";

const config: ExtractConfig = {
  adapterId: "generic",
  toolKinds: {
    write: "file.modified",
    read: "file.read",
    create: "file.created",
    bash: "command",
  },
  scopeRoots: [{ root: "/workspace/repo", scope: "repo" }],
  cwd: "/workspace/repo",
  repoRoot: "/workspace/repo",
  pathBase: "repo",
  decisionCues: ["we will", "must"],
};

const tool = (
  entry: number,
  line: number,
  toolName: string,
  values: Partial<NormalizedToolEvent> = {},
): NormalizedToolEvent => ({
  type: "tool",
  entry,
  line,
  rawLine: `seed-${entry}-${line}-${toolName}`,
  timestamp: null,
  toolCallId: `seed-call-${entry}-${line}`,
  toolName,
  isError: false,
  ...values,
});

const events: NormalizedEvent[] = [
  tool(2, 10, "bash", { command: "npm test", isError: true, errorMessage: "permission denied" }),
  tool(8, 20, "bash", { command: "npm test", isError: true, errorMessage: "timed out waiting" }),
  tool(10, 30, "bash", { command: "npm test", isError: false }),
  tool(20, 90, "bash", { command: "npm lint", isError: true, errorMessage: "connection refused" }),
  tool(20, 91, "bash", { command: "npm lint", isError: true, errorMessage: "not found" }),
  tool(3, 11, "write", { path: "src/alpha.ts", intent: "write alpha" }),
  tool(6, 12, "write", { path: "src/beta.ts", intent: "write beta" }),
  tool(14, 40, "read", { path: "src/alpha.ts", intent: "read alpha" }),
  tool(25, 100, "create", { path: "src/created.ts", intent: "create file" }),
];

// The duplicate has the same occurrence and evidence, so it must be a no-op in the merge.
events.push(events.at(-1) as NormalizedToolEvent);

const shuffleSeeds = [
  0x00000001,
  0x10203040,
  0x13579bdf,
  0x2468ace0,
  0x31415926,
  0x55aa55aa,
  0x7fffffff,
  0x80000000,
  0x89abcdef,
  0xa5a5a5a5,
  0xc001d00d,
  0xdeadcafe,
  0xe1e2e3e4,
  0xf00dbabe,
  0xfedcba98,
  0xffffffff,
] as const;

function nextUint32(state: { value: number }): number {
  state.value = (Math.imul(state.value, 1_664_525) + 1_013_904_223) >>> 0;
  return state.value;
}

function permutation<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  const state = { value: seed >>> 0 };
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = nextUint32(state) % (index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

describe("seeded extraction permutations", () => {
  it("keeps payload bytes and hashes invariant for fixed-seed permutations", () => {
    const expected = extractPayload(events, config);
    const expectedHash = payloadHash(expected);

    for (const seed of shuffleSeeds) {
      const actual = extractPayload(permutation(events, seed), config);
      expect(actual).toEqual(expected);
      expect(payloadHash(actual)).toBe(expectedHash);
    }
  });

  it("applies the total provenance tie rule to scalar attrs", () => {
    const facts = extractFacts(events, config);
    const testFailure = facts.find((fact) => fact.kind === "cmd.failed" && fact.key === "npm test");
    const lintFailure = facts.find((fact) => fact.kind === "cmd.failed" && fact.key === "npm lint");

    expect(testFailure?.attrs.last_error_class).toBe("timeout");
    expect(lintFailure?.attrs.last_error_class).toBe("not_found");
  });

  it("treats equal entry-and-line identical facts as a no-op", () => {
    const created = events.at(-1) as NormalizedToolEvent;
    const once = extractFacts([created], config);
    const twice = extractFacts([created, created], config);

    expect(twice).toEqual(once);
  });
});
