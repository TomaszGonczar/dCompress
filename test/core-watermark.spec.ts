import { describe, expect, it } from "vitest";

import {
  contextUsagePpm,
  DEFAULT_CONTEXT_WATERMARK_PPM,
  evaluateWatermark,
  INITIAL_WATERMARK_ARM_STATE,
} from "../src/core/watermark.js";
import type { WatermarkArmState } from "../src/core/watermark.js";

const LIMIT = 1_000_000;

describe("contextUsagePpm", () => {
  it("computes floor(used * 1e6 / limit) in integer arithmetic", () => {
    expect(contextUsagePpm(659_999, LIMIT)).toBe(659_999);
    expect(contextUsagePpm(660_000, LIMIT)).toBe(660_000);
    expect(contextUsagePpm(132_000, 200_000)).toBe(660_000);
    // Non-exact division floors rather than rounds.
    expect(contextUsagePpm(1, 3)).toBe(333_333);
  });

  it("degrades absent, zero, negative, fractional, or inconsistent telemetry to null", () => {
    expect(contextUsagePpm(undefined, LIMIT)).toBeNull();
    expect(contextUsagePpm(100, undefined)).toBeNull();
    expect(contextUsagePpm(null, LIMIT)).toBeNull();
    expect(contextUsagePpm(0, LIMIT)).toBeNull();
    expect(contextUsagePpm(100, 0)).toBeNull();
    expect(contextUsagePpm(-1, LIMIT)).toBeNull();
    expect(contextUsagePpm(100, -1)).toBeNull();
    expect(contextUsagePpm(100.5, LIMIT)).toBeNull();
    expect(contextUsagePpm(100, LIMIT + 0.5)).toBeNull();
    // used > limit: no real context window produces this, so it is corrupt, not "over 100%".
    expect(contextUsagePpm(LIMIT + 1, LIMIT)).toBeNull();
    expect(contextUsagePpm("660000", LIMIT)).toBeNull();
  });
});

describe("evaluateWatermark", () => {
  it("does not fire at 659,999 ppm", () => {
    const outcome = evaluateWatermark(659_999, LIMIT, 1, DEFAULT_CONTEXT_WATERMARK_PPM, INITIAL_WATERMARK_ARM_STATE);
    expect(outcome.action).toBe("hold");
    expect(outcome.ppm).toBe(659_999);
    expect(outcome.state).toEqual({ epoch: 1, fired: false });
  });

  it("fires exactly once at 660,000 ppm", () => {
    const first = evaluateWatermark(660_000, LIMIT, 1, DEFAULT_CONTEXT_WATERMARK_PPM, INITIAL_WATERMARK_ARM_STATE);
    expect(first.action).toBe("fire");
    expect(first.ppm).toBe(660_000);
    expect(first.state).toEqual({ epoch: 1, fired: true });

    // Repeated observations above the watermark, same epoch: idempotent, no duplicate fire.
    const second = evaluateWatermark(700_000, LIMIT, 1, DEFAULT_CONTEXT_WATERMARK_PPM, first.state);
    expect(second.action).toBe("hold");
    expect(second.ppm).toBe(700_000);
    expect(second.state).toEqual({ epoch: 1, fired: true });

    const third = evaluateWatermark(660_000, LIMIT, 1, DEFAULT_CONTEXT_WATERMARK_PPM, second.state);
    expect(third.action).toBe("hold");
  });

  it("re-arms only after an observed epoch advance, never merely by dropping under threshold", () => {
    const fired = evaluateWatermark(660_000, LIMIT, 1, DEFAULT_CONTEXT_WATERMARK_PPM, INITIAL_WATERMARK_ARM_STATE);
    expect(fired.action).toBe("fire");

    // Same epoch, a lower reading: still held, and the epoch stays fired for any later reading.
    const stillLowSameEpoch = evaluateWatermark(1, LIMIT, 1, DEFAULT_CONTEXT_WATERMARK_PPM, fired.state);
    expect(stillLowSameEpoch.action).toBe("hold");
    const stillHighSameEpoch = evaluateWatermark(900_000, LIMIT, 1, DEFAULT_CONTEXT_WATERMARK_PPM, stillLowSameEpoch.state);
    expect(stillHighSameEpoch.action).toBe("hold");

    // A new observed epoch re-arms: the same threshold fires again.
    const newEpoch = evaluateWatermark(660_000, LIMIT, 2, DEFAULT_CONTEXT_WATERMARK_PPM, stillHighSameEpoch.state);
    expect(newEpoch.action).toBe("fire");
    expect(newEpoch.state).toEqual({ epoch: 2, fired: true });
  });

  it("degrades missing, zero, negative, fractional, or inconsistent telemetry to threshold-unsupported without guessing or consuming the arm state", () => {
    const state: WatermarkArmState = { epoch: 3, fired: false };
    for (const [used, limit] of [
      [undefined, LIMIT],
      [660_000, undefined],
      [0, LIMIT],
      [660_000, 0],
      [-1, LIMIT],
      [660_000.5, LIMIT],
      [LIMIT + 1, LIMIT],
    ] as const) {
      const outcome = evaluateWatermark(used, limit, 3, DEFAULT_CONTEXT_WATERMARK_PPM, state);
      expect(outcome.action).toBe("threshold-unsupported");
      expect(outcome.ppm).toBeNull();
      // Never a guess at arm/fire state either: the epoch's one-shot budget is untouched.
      expect(outcome.state).toEqual(state);
    }
  });
});
