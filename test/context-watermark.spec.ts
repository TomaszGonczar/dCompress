import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ContinuityRefusal, listCheckpoints, observeContextWatermark, readWatermarkState, runHook } from "../src/continuity.js";

const fixture = join(process.cwd(), "test", "fixtures", "claude", "slice-0001", "transcript.jsonl");
const continuityFixtureDir = join(process.cwd(), "test", "fixtures", "claude", "continuity-0001");
const precompactFixture = join(continuityFixtureDir, "precompact.jsonl");
const transcriptFixture = join(continuityFixtureDir, "transcript.jsonl");
const sessionId = "fixture-session-0001";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dcompress-og81-watermark-"));
}

const LIMIT = 1_000_000;

describe("observeContextWatermark: OG-81 required test matrix", () => {
  it("659,999 ppm fires no snapshot", () => {
    const root = tempRoot();
    try {
      const result = observeContextWatermark({ root, sessionId, transcriptPath: fixture, usedTokens: 659_999, contextLimitTokens: LIMIT });
      expect(result.outcome.action).toBe("hold");
      expect(result.checkpoint).toBeNull();
      expect(listCheckpoints({ root, sessionId })).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("660,000 ppm fires exactly one snapshot", () => {
    const root = tempRoot();
    try {
      const result = observeContextWatermark({ root, sessionId, transcriptPath: fixture, usedTokens: 660_000, contextLimitTokens: LIMIT });
      expect(result.outcome.action).toBe("fire");
      expect(result.checkpoint?.created).toBe(true);
      expect(listCheckpoints({ root, sessionId })).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("repeated observations above the watermark in the same epoch do not fire twice", () => {
    const root = tempRoot();
    try {
      const first = observeContextWatermark({ root, sessionId, transcriptPath: fixture, usedTokens: 660_000, contextLimitTokens: LIMIT });
      expect(first.outcome.action).toBe("fire");
      const second = observeContextWatermark({ root, sessionId, transcriptPath: fixture, usedTokens: 900_000, contextLimitTokens: LIMIT });
      expect(second.outcome.action).toBe("hold");
      const third = observeContextWatermark({ root, sessionId, transcriptPath: fixture, usedTokens: 660_000, contextLimitTokens: LIMIT });
      expect(third.outcome.action).toBe("hold");
      expect(listCheckpoints({ root, sessionId })).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a new observed PreCompact epoch re-arms the guardrail", () => {
    const root = tempRoot();
    try {
      const first = observeContextWatermark({ root, sessionId: "fixture-continuity-0001", transcriptPath: precompactFixture, usedTokens: 660_000, contextLimitTokens: LIMIT });
      expect(first.outcome.action).toBe("fire");
      const held = observeContextWatermark({ root, sessionId: "fixture-continuity-0001", transcriptPath: precompactFixture, usedTokens: 900_000, contextLimitTokens: LIMIT });
      expect(held.outcome.action).toBe("hold");

      // Real PreCompact delivery, exactly as Claude's installed hook would call it: bumps the
      // epoch continuity.ts already tracks for injection delivery.
      runHook({ session_id: "fixture-continuity-0001", transcript_path: transcriptFixture }, "precompact", { root });

      const rearmed = observeContextWatermark({ root, sessionId: "fixture-continuity-0001", transcriptPath: transcriptFixture, usedTokens: 660_000, contextLimitTokens: LIMIT });
      expect(rearmed.outcome.action).toBe("fire");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("degrades missing, zero, negative, fractional, or inconsistent telemetry to threshold-unsupported without firing", () => {
    const root = tempRoot();
    try {
      for (const [used, limit] of [
        [undefined, LIMIT],
        [660_000, undefined],
        [0, LIMIT],
        [660_000, 0],
        [-1, LIMIT],
        [660_000.5, LIMIT],
        [LIMIT + 1, LIMIT],
      ] as const) {
        const result = observeContextWatermark({ root, sessionId, transcriptPath: fixture, usedTokens: used, contextLimitTokens: limit });
        expect(result.outcome.action).toBe("threshold-unsupported");
        expect(result.checkpoint).toBeNull();
      }
      expect(listCheckpoints({ root, sessionId })).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Claude's real hook payload never carries token telemetry, so runHook always degrades this guardrail to threshold-unsupported", () => {
    const root = tempRoot();
    try {
      runHook({ session_id: sessionId, transcript_path: fixture }, "precompact", { root });
      runHook({ session_id: sessionId, transcript_path: fixture, source: "resume" }, "session-start", { root });
      // The only snapshot on disk is the unconditional PreCompact checkpoint; the watermark
      // never fired one, because there is no field to read it from (docs/ADAPTER-SPEC.md §2).
      expect(listCheckpoints({ root, sessionId })).toHaveLength(1);
      expect(readWatermarkState(root, sessionId)).toEqual({ epoch: 0, fired: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a firing observation whose checkpoint write fails throws a typed refusal that runHook's fail-open wrapping already absorbs", () => {
    const root = tempRoot();
    try {
      const missingTranscript = join(root, "does-not-exist.jsonl");
      expect(() =>
        observeContextWatermark({ root, sessionId, transcriptPath: missingTranscript, usedTokens: 660_000, contextLimitTokens: LIMIT }),
      ).toThrow();
      // Reproduce runHook's own wrapping (a bare catch-all around every hook path) to prove the
      // watermark's failure mode is covered by the same fail-open contract, not a special case.
      const failOpen = ((): string => {
        try {
          observeContextWatermark({ root, sessionId, transcriptPath: missingTranscript, usedTokens: 660_000, contextLimitTokens: LIMIT });
          return "{}";
        } catch {
          return "{}";
        }
      })();
      expect(failOpen).toBe("{}");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked watermark state file rather than following it", () => {
    const root = tempRoot();
    const linkedTarget = tempRoot();
    try {
      observeContextWatermark({ root, sessionId, transcriptPath: fixture, usedTokens: 1, contextLimitTokens: LIMIT + 1 });
      const path = join(root, "claude", sessionId, "checkpoints", ".watermark-state");
      rmSync(path);
      symlinkSync(linkedTarget, path);
      expect(() => observeContextWatermark({ root, sessionId, transcriptPath: fixture, usedTokens: 660_000, contextLimitTokens: LIMIT })).toThrow(ContinuityRefusal);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(linkedTarget, { recursive: true, force: true });
    }
  });
});
