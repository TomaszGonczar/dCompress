export interface Clock {
  now(): number;
}

/** The sole wall-clock boundary in core. All other code receives a Clock. */
export const systemClock: Clock = Object.freeze({
  now: (): number => Date.now(),
});

export function fixedClock(value: number): Clock {
  if (!Number.isFinite(value)) {
    throw new RangeError("fixedClock requires a finite timestamp");
  }
  return Object.freeze({ now: (): number => value });
}
