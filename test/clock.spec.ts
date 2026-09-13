import { describe, expect, it } from "vitest";

import { fixedClock, systemClock } from "../src/core/clock.js";

describe("clock boundary", () => {
  it("reads the system clock through systemClock", () => {
    const before = Date.now();
    const observed = systemClock.now();
    const after = Date.now();
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });

  it("provides a stable clock for a numeric timestamp", () => {
    const clock = fixedClock(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite numeric timestamps: %s",
    (value) => {
      expect(() => fixedClock(value)).toThrow(RangeError);
    },
  );

  it.each([null, "1970-01-01T00:00:00.000Z", new Date(0)])(
    "rejects non-numeric timestamp values: %s",
    (value) => {
      expect(() => fixedClock(value as unknown as number)).toThrow(RangeError);
    },
  );

  it("accepts finite numeric epoch milliseconds only", () => {
    expect(fixedClock(1_700_000_000_000.5).now()).toBe(1_700_000_000_000.5);
  });
});
