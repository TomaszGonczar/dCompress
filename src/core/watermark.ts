/**
 * Context-watermark guardrail (OG-81): pure integer math plus epoch-scoped arm/fire state.
 *
 * No I/O, no clock, no guessing. A caller supplies `usedTokens`/`contextLimitTokens` from
 * telemetry it has already confirmed exists; this module never invents either number, and it
 * never decides *how often* to be called — that is the caller's epoch to track (AGENTS
 * invariants 1, 2, 3, 8).
 */

/** SCHEMA/OG-81 default: fire once context usage reaches 66.0% of the limit. */
export const DEFAULT_CONTEXT_WATERMARK_PPM = 660_000;

/** Persisted between hook invocations so "at most once per epoch" survives a fresh process. */
export interface WatermarkArmState {
  readonly epoch: number;
  readonly fired: boolean;
}

export const INITIAL_WATERMARK_ARM_STATE: WatermarkArmState = Object.freeze({ epoch: 0, fired: false });

export type WatermarkAction = "fire" | "hold" | "threshold-unsupported";

export interface WatermarkOutcome {
  readonly action: WatermarkAction;
  /** `null` only for `threshold-unsupported`, where there is no reading to report. */
  readonly ppm: number | null;
  readonly state: WatermarkArmState;
}

/**
 * `floor(usedTokens * 1_000_000 / contextLimitTokens)`, computed in integer (`BigInt`)
 * arithmetic so no float rounding can move a reading across the fire threshold.
 *
 * `null` for telemetry this guardrail must never guess at: absent, non-integer,
 * zero-or-negative, or `usedTokens` exceeding `contextLimitTokens` — a reading no real context
 * window can produce, so it is corrupt telemetry rather than "over 100%".
 */
export function contextUsagePpm(usedTokens: unknown, contextLimitTokens: unknown): number | null {
  if (!Number.isSafeInteger(usedTokens) || !Number.isSafeInteger(contextLimitTokens)) return null;
  const used = usedTokens as number;
  const limit = contextLimitTokens as number;
  if (used <= 0 || limit <= 0 || used > limit) return null;
  return Number((BigInt(used) * 1_000_000n) / BigInt(limit));
}

/**
 * One observation. `epoch` is the same compaction-epoch counter `continuity.ts` already tracks
 * for injection delivery: crossing the threshold fires at most once per epoch, and re-arms only
 * when `epoch` advances past `state.epoch` — never merely because a later reading drops back
 * under the threshold within the same epoch.
 *
 * Invalid telemetry always reports `threshold-unsupported` and leaves `state` untouched: a
 * missing reading must never consume an epoch's one-shot fire, and must never re-arm one either.
 */
export function evaluateWatermark(
  usedTokens: unknown,
  contextLimitTokens: unknown,
  epoch: number,
  ppmThreshold: number,
  state: WatermarkArmState,
): WatermarkOutcome {
  const ppm = contextUsagePpm(usedTokens, contextLimitTokens);
  if (ppm === null) return { action: "threshold-unsupported", ppm: null, state };
  const armed: WatermarkArmState = epoch === state.epoch ? state : { epoch, fired: false };
  if (ppm < ppmThreshold || armed.fired) return { action: "hold", ppm, state: armed };
  return { action: "fire", ppm, state: { epoch: armed.epoch, fired: true } };
}
