import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { restoreVerifiedBinding, digest as sha256 } from "./og86-binding.mjs";
import { matrixExpectations, probeMatrix, requiredLocationClasses } from "../../docs/benchmark/og86-medium-v1/harness/hook.mjs";

/** The preregistered verdict for every probe, as a lookup. */
const EXPECTED_MATRIX = matrixExpectations().map((plan) => ({
  name: plan.name,
  allowed: plan.expected === "allow",
  location: plan.location,
  classChecked: plan.classChecked === true,
}));

/** The probe matrix the continuation must observe, re-exported for callers. */
export { matrixExpectations, requiredLocationClasses };

/**
 * OG-86 medium-series controller.
 *
 * One deterministic state machine drives every scored arm through four
 * checkpoints and four operator-invoked manual compactions. The checkpoint
 * order is the preregistered order: prompt, acceptance, one manual compact,
 * native-summary capture, fork, score the fork with tools disabled, verify the
 * source is byte-identical, and only then resume the source with the arm's
 * treatment. Forking before the source resume is what keeps a B/C score fork
 * from inheriting the parent treatment and then receiving the score-fork
 * treatment a second time.
 *
 * Every gate is evaluated where its observation arrives. The controller never
 * writes a result on a false gate, never treats an advisory cost figure as a
 * stop, and keeps the emergency runaway ceiling a separate operational stop.
 *
 * Side effects live behind `isDirectExecution()`. Importing this module is
 * inert so tests can drive the machine with a scripted driver.
 */

export const FROZEN = Object.freeze({
  series: "OG86-medium-v1",
  model: "claude-haiku-4-5-20251001",
  phases: 4,
  manualCompactionsPerArm: 4,
  advisoryPerArmUsd: 0.35,
  advisorySeriesUsd: 1.2,
  runawayPerArmUsd: 5,
  runawaySeriesUsd: 15,
  perArmMinutes: 60,
  seriesMinutes: 210,
  assistantTurnsPerArm: 48,
  treatmentMaxBytes: 16_384,
  arms: Object.freeze(["A", "B", "C"]),
  operationalStopCodes: Object.freeze(["emergency-runaway-ceiling-reached"]),
});

/**
 * Ordered checkpoint steps. `role` is the schema role every process label this
 * step creates is recorded under.
 */
export const CHECKPOINT_SEQUENCE = Object.freeze([
  Object.freeze({ step: "send-phase-prompt", role: "work" }),
  Object.freeze({ step: "run-phase-acceptance", role: "work" }),
  Object.freeze({ step: "invoke-manual-compact", role: "compact" }),
  Object.freeze({ step: "capture-native-summary", role: "compact" }),
  Object.freeze({ step: "create-score-fork", role: "probe" }),
  Object.freeze({ step: "resume-fork-tools-disabled", role: "probe" }),
  Object.freeze({ step: "verify-source-stability", role: "probe" }),
  Object.freeze({ step: "resume-source-with-treatment", role: "continuation" }),
]);

export const STEP_INDEX = Object.freeze(Object.fromEntries(CHECKPOINT_SEQUENCE.map((entry, index) => [entry.step, index])));

/** Blinded public labels. The mapping is deterministic and arm-order dependent. */
export function blinding(order) {
  return Object.fromEntries(order.map((arm, index) => [arm, `X${index + 1}`]));
}

/** Arm order is derived only from an existing freeze commit — never guessed. */
export function armOrder(freezeCommit) {
  if (typeof freezeCommit !== "string" || !/^[0-9a-f]{40}$/.test(freezeCommit)) {
    throw new Error("freezeCommit must be a 40-character lowercase hex revision");
  }
  return [...FROZEN.arms]
    .map((arm) => ({ arm, key: createHash("sha256").update(`${FROZEN.series}|${freezeCommit}|${arm}`).digest("hex") }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((entry) => entry.arm);
}

/** Per-arm accumulator. Every gate is decided where its observation arrives. */
function armState(arm) {
  return {
    arm,
    checkpoints: [],
    invalidations: [],
    operationalStops: [],
    advisoryOverages: [],
    advisoryUsd: 0,
    wallSeconds: 0,
    assistantTurns: 0,
    processes: [],
  };
}

export function initialState(order) {
  if (!Array.isArray(order) || order.length !== 3 || new Set(order).size !== 3) {
    throw new Error("arm order must be a permutation of A, B, C");
  }
  return {
    order,
    blinding: blinding(order),
    phase: 1,
    step: 0,
    completed: [],
    arms: Object.fromEntries(order.map((arm) => [arm, armState(arm)])),
    observations: [],
    invalidations: [],
    operationalStops: [],
  };
}

function push(target, collection, value) {
  if (value !== null && value !== undefined && !collection.includes(value)) collection.push(value);
}

function invalidate(target, arm, code) {
  push(target, arm.invalidations, code);
  push(target, target.invalidations, `${arm.arm}:${code}`);
}

function stopOperationally(target, arm, code) {
  push(target, arm.operationalStops, code);
  push(target, target.operationalStops, `${arm.arm}:${code}`);
}

function modelGate(target, arm, observation, where, delta) {
  // Reads the per-invocation delta, never the cumulative transcript total.
  const reading = delta ?? observation.models ?? {};
  if (!modelReadingValid(reading) || (reading.assistantRecords ?? 0) === 0) {
    invalidate(target, arm, `assistant-records-missing:${where}`);
    return;
  }
  const names = Object.keys(reading.counts ?? {});
  if (names.some((name) => name !== FROZEN.model)) invalidate(target, arm, `model-id-mismatch:${where}`);
  if ((reading.fallbackRecords ?? 0) !== 0) invalidate(target, arm, `model-switch-recorded:${where}`);
}

function costGate(target, arm) {
  if (arm.advisoryUsd > FROZEN.advisoryPerArmUsd) push(target, arm.advisoryOverages, "per-arm-advisory");
  if (arm.advisoryUsd > FROZEN.runawayPerArmUsd) stopOperationally(target, arm, "emergency-runaway-ceiling-reached");
  if (arm.wallSeconds / 60 > FROZEN.perArmMinutes) invalidate(target, arm, "per-arm-wall-clock-limit-exceeded");
  if (arm.assistantTurns > FROZEN.assistantTurnsPerArm) invalidate(target, arm, "assistant-turn-limit-exceeded");
}

/**
 * Record a labeled process using its per-invocation delta. The cumulative
 * transcript total is kept alongside so a reader can reconstruct either view.
 */
function recordProcess(target, state, observation, { label, role, incarnation }, delta) {
  const reading = delta ?? transcriptDelta(observation.previousModels, observation.models);
  state.processes.push({
    label,
    role,
    incarnation,
    assistantRecords: reading.assistantRecords,
    matchingModelRecords: reading.matchingModelRecords,
    fallbackOrModelSwitchRecords: reading.fallbackRecords,
    cumulativeAssistantRecords: reading.cumulative?.assistantRecords ?? null,
    monotonic: reading.monotonic !== false,
  });
  // An append-only transcript cannot shrink, so a negative delta means the wrong
  // transcript was sampled. That is an invalidity, reported through the same
  // path as every other gate so it reaches the series level too.
  if (reading.monotonic === false) {
    invalidate(target, state, `non-monotonic-transcript-delta:${label}`);
  }
}

/**
 * Every step contributes its own wall time and its own model delta; the arm and
 * series totals are sums. `turns` is the per-invocation delta when the step
 * reports one, so a ceiling breach is measured per invocation rather than
 * triggered by the arm's cumulative total.
 */
function accumulate(state, observation) {
  const wallSeconds = observation.wallSeconds ?? 0;
  const delta = transcriptDelta(observation.previousModels, observation.models);
  state.wallSeconds += wallSeconds;
  state.assistantTurns += delta.assistantRecords;
  state.advisoryUsd += observation.costUsd ?? 0;
  const record = checkpointRecord(state, observation.phase);
  record.elapsedWallSeconds = (record.elapsedWallSeconds ?? 0) + wallSeconds;
  record.assistantTurns = (record.assistantTurns ?? 0) + delta.assistantRecords;
  return delta;
}

function checkpointRecord(state, phase) {
  let record = state.checkpoints.find((entry) => entry.ordinal === phase);
  if (record === undefined) {
    record = { ordinal: phase, manualCompaction: false, steps: [] };
    state.checkpoints.push(record);
    state.checkpoints.sort((left, right) => left.ordinal - right.ordinal);
  }
  return record;
}

function recordStep(target, arm, phase, step, extra) {
  const state = target.arms[arm];
  const expected = CHECKPOINT_SEQUENCE[target.step];
  if (expected === undefined || expected.step !== step) {
    invalidate(target, state, `checkpoint-order-violated:${step}`);
    return null;
  }
  if (target.phase !== phase || target.step !== STEP_INDEX[step]) {
    invalidate(target, state, `checkpoint-sequence-violated:${step}`);
    return null;
  }
  const record = checkpointRecord(state, phase);
  record.steps.push(step);
  target.step += 1;
  target.observations.push({ arm, phase, step, ...extra });
  return record;
}

/**
 * Apply one observation. Returns the (mutated) state; every gate fires here, at
 * the observation that can decide it.
 */
export function record(target, arm, observation) {
  const state = target.arms[arm];
  if (state === undefined) throw new Error(`unknown arm ${arm}`);
  const phase = observation.phase;

  switch (observation.kind) {
    case "phase-prompt": {
      recordStep(target, arm, phase, "send-phase-prompt", observation);
      const delta = accumulate(state, observation);
      modelGate(target, state, observation, `work:${phase}`, delta);
      recordProcess(target, state, observation, { label: `${arm}:${phase}:work`, role: "work", incarnation: 1 }, delta);
      break;
    }
    case "phase-acceptance": {
      recordStep(target, arm, phase, "run-phase-acceptance", observation);
      accumulate(state, observation);
      if (observation.passed !== true) invalidate(target, state, `phase-acceptance-failed:${phase}`);
      break;
    }
    case "compact-requested": {
      if (observation.trigger !== "manual") invalidate(target, state, `unscheduled-compaction:${observation.trigger}`);
      break;
    }
    case "compact-complete": {
      const record = recordStep(target, arm, phase, "invoke-manual-compact", observation);
      const delta = accumulate(state, observation);
      if (record) record.manualCompaction = true;
      // A treatment that reached the source before this phase's fork would be
      // inherited by the fork and injected a second time on resume.
      if ((observation.treatmentBytes ?? 0) > 0) invalidate(target, state, `treatment-before-fork:${phase}`);
      modelGate(target, state, observation, `compact:${phase}`, delta);
      recordProcess(target, state, observation, { label: `${arm}:${phase}:compact`, role: "compact", incarnation: 1 }, delta);
      break;
    }
    case "summary-captured": {
      const record = recordStep(target, arm, phase, "capture-native-summary", observation);
      accumulate(state, observation);
      if (record) record.nativeSummaryBytes = observation.bytes ?? 0;
      if (typeof observation.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(observation.sha256)) {
        invalidate(target, state, `native-summary-unverifiable:${phase}`);
      }
      break;
    }
    case "fork-created": {
      const record = recordStep(target, arm, phase, "create-score-fork", observation);
      const delta = accumulate(state, observation);
      if (record) {
        // Field names follow artifact-schema.json exactly so a consumer can
        // validate the emitted artifact without a translation table.
        record.sourceTranscriptBytesBefore = observation.source.bytes;
        record.sourceTranscriptLinesBefore = observation.source.lines;
        record.sourceTranscriptSha256Before = observation.source.sha256;
      }
      if (observation.distinct !== true) invalidate(target, state, `fork-session-not-distinct:${phase}`);
      modelGate(target, state, observation, `fork:${phase}`, delta);
      recordProcess(target, state, observation, { label: `${arm}:${phase}:fork`, role: "probe", incarnation: 1 }, delta);
      break;
    }
    case "fork-probed": {
      const record = recordStep(target, arm, phase, "resume-fork-tools-disabled", observation);
      const delta = accumulate(state, observation);
      if (record) {
        record.treatmentBytes = observation.treatmentBytes ?? 0;
        record.treatmentSha256 = observation.treatmentSha256 ?? null;
        record.probeToolDecisions = observation.toolDecisions ?? [];
        record.score = observation.score ?? null;
      }
      if (record && record.score === null) invalidate(target, state, `probe-score-missing:${phase}`);
      if (observation.scoreRefusal !== null && observation.scoreRefusal !== undefined) {
        // A malformed probe body is a refusal, not a zero score.
        invalidate(target, state, `probe-response-refused:${observation.scoreRefusal.reason}:${phase}`);
      }
      if ((observation.treatmentCopies ?? 0) !== (arm === "A" ? 0 : 1)) {
        invalidate(target, state, `treatment-absent-or-duplicated:${phase}`);
      }
      if (arm !== "A" && (observation.treatmentBytes ?? 0) === 0) invalidate(target, state, `treatment-absent:${phase}`);
      if ((observation.treatmentBytes ?? 0) > FROZEN.treatmentMaxBytes) invalidate(target, state, `treatment-over-budget:${phase}`);
      if ((observation.toolDecisions ?? []).some((entry) => entry.allowed === true)) {
        invalidate(target, state, `probe-used-tools:${phase}`);
      }
      modelGate(target, state, observation, `probe:${phase}`, delta);
      // The fork probe's counts must be attributable to this invocation. An
      // inherited fork total is not the probe's work, so an unproven reading is
      // a refusal rather than a number.
      if (observation.models?.proven === false) {
        invalidate(target, state, `fork-probe-attribution-unproven:${phase}`);
      }
      recordProcess(target, state, observation, { label: `${arm}:${phase}:probe`, role: "probe", incarnation: 2 }, delta);
      break;
    }
    case "source-verified": {
      const record = recordStep(target, arm, phase, "verify-source-stability", observation);
      accumulate(state, observation);
      if (record) {
        record.sourceTranscriptBytesAfter = observation.source.bytes;
        record.sourceTranscriptLinesAfter = observation.source.lines;
        record.sourceTranscriptSha256After = observation.source.sha256;
        record.sourceTranscriptStable = record.sourceTranscriptSha256Before === observation.source.sha256
          && record.sourceTranscriptBytesBefore === observation.source.bytes
          && record.sourceTranscriptLinesBefore === observation.source.lines;
        record.canaryOccurrenceCount = observation.canaryOccurrenceCount ?? 0;
        record.privateTreeModes = sanitizedModes(observation.privateTreeModes);
      }
      if (record && record.sourceTranscriptStable !== true) invalidate(target, state, `source-transcript-changed:${phase}`);
      if (record && record.canaryOccurrenceCount !== 0) invalidate(target, state, `canary-observed:${phase}`);
      // Required evidence at every checkpoint: owner-only directories and files,
      // and no symlinks. A missing reading is a refusal, not an assumed pass.
      const modes = observation.privateTreeModes;
      if (modes === null || modes === undefined) {
        invalidate(target, state, `private-tree-modes-missing:${phase}`);
      } else {
        // Content, not just presence: a reading that measured nothing cannot
        // attest that anything is owner-only.
        if (modes.rootPresent !== true) invalidate(target, state, `private-tree-root-absent:${phase}`);
        if ((modes.readFailureCount ?? 0) !== 0) invalidate(target, state, `private-tree-unreadable:${phase}`);
        if ((modes.directoryCount ?? 0) < 1) invalidate(target, state, `private-tree-no-directories:${phase}`);
        if ((modes.fileCount ?? 0) < 1) invalidate(target, state, `private-tree-no-files:${phase}`);
        if (modes.allDirectoriesOwnerOnly !== true) invalidate(target, state, `private-tree-directory-mode:${phase}`);
        if (modes.allFilesOwnerOnly !== true) invalidate(target, state, `private-tree-file-mode:${phase}`);
        if (modes.zeroSymlinks !== true) invalidate(target, state, `private-tree-symlink:${phase}`);
      }
      break;
    }
    case "source-resumed": {
      const record = recordStep(target, arm, phase, "resume-source-with-treatment", observation);
      const delta = accumulate(state, observation);
      if (record) {
        record.resumeTreatmentBytes = observation.treatmentBytes ?? 0;
        record.resumeTreatmentSha256 = observation.treatmentSha256 ?? null;
      }
      if ((observation.treatmentCopies ?? 0) !== (arm === "A" ? 0 : 1)) {
        invalidate(target, state, `treatment-absent-or-duplicated:resume:${phase}`);
      }
      if (arm !== "A" && (observation.treatmentBytes ?? 0) === 0) invalidate(target, state, `treatment-absent:resume:${phase}`);
      modelGate(target, state, observation, `continuation:${phase}`, delta);
      const mismatches = matrixMismatches(observation.toolProbes);
      if (mismatches.length > 0) invalidate(target, state, `tool-matrix-incomplete:${phase}:${mismatches.length}`);
      recordProcess(target, state, observation, { label: `${arm}:${phase}:continuation`, role: "continuation", incarnation: 1 }, delta);
      // The continuation must receive the same frozen treatment the score fork
      // received. A different byte length or digest means the arm was scored on
      // one treatment and continued on another, which makes the comparison
      // between scoring and continuation meaningless.
      const identity = treatmentIdentity({ arm, phase, record, observation });
      if (record) record.treatmentIdentity = identity;
      if (identity.matches !== true) invalidate(target, state, `treatment-identity-mismatch:${phase}`);
      if (arm === "C") {
        const binding = armCBinding(observation.binding);
        if (record) record.armC = binding.values;
        for (const [gate, ok] of Object.entries(binding.gates)) {
          if (ok !== true) invalidate(target, state, `arm-c-binding-${gate}:${phase}`);
        }
      } else if (record) {
        record.armC = null;
      }
      break;
    }
    default:
      throw new Error(`unknown observation kind ${observation.kind}`);
  }
  costGate(target, state);
  return target;
}

/**
 * Every probe must agree on the verdict, and every location-class denial must
 * additionally report the **preregistered class**.
 *
 * Shape probes (missing path, unknown tool) and Bash probes are exempt from the
 * class requirement: they are denied before any location is resolved, so they
 * have no class to report. Their verdict is still checked.
 */
export function matrixMismatches(observed) {
  if (!Array.isArray(observed)) return ["missing-probe-matrix"];
  const byName = new Map(observed.map((row) => [row.name, row]));
  const failures = [];
  for (const expected of EXPECTED_MATRIX) {
    const row = byName.get(expected.name);
    if (row === undefined) {
      failures.push(`${expected.name}:absent`);
      continue;
    }
    if (row.allowed !== expected.allowed) {
      failures.push(`${expected.name}:verdict`);
      continue;
    }
    if (expected.classChecked !== true || expected.allowed === true) continue;
    if (row.observedClass !== expected.location) {
      // Right verdict, wrong reason: the denial is real but not attributable to
      // the class the matrix claims.
      failures.push(`${expected.name}:class:${row.observedClass}`);
    }
  }
  return failures;
}

/**
 * The control arm receives no treatment, so identity is trivially satisfied by
 * zero bytes and a null digest. An active arm must match its score fork on both
 * byte length and digest.
 */
export function treatmentIdentity({ arm, phase, record, observation }) {
  const resume = {
    bytes: observation.treatmentBytes ?? 0,
    sha256: observation.treatmentSha256 ?? null,
  };
  const scored = {
    bytes: record?.treatmentBytes ?? 0,
    sha256: record?.treatmentSha256 ?? null,
  };
  if (arm === "A") {
    return { arm, phase, scored, resume, matches: scored.bytes === 0 && resume.bytes === 0, reason: "control-arm" };
  }
  const sameBytes = scored.bytes === resume.bytes && scored.bytes > 0;
  const sameDigest = typeof scored.sha256 === "string" && scored.sha256 === resume.sha256;
  return {
    arm,
    phase,
    scored,
    resume,
    matches: sameBytes && sameDigest,
    reason: sameBytes ? (sameDigest ? "identical" : "digest-differs") : "byte-length-differs",
  };
}

/**
 * Arm C must prove its pack came from a checkpoint bound to the retained
 * transcript. A missing binding is a refusal, not an assumed pass.
 */
function armCBinding(binding) {
  if (binding === null || typeof binding !== "object") {
    return {
      values: null,
      gates: { present: false },
    };
  }
  const required = binding.checkpointEvidenceEntriesRequired ?? 0;
  const matched = binding.checkpointEvidenceEntriesMatched ?? 0;
  return {
    values: binding,
    gates: {
      present: true,
      envelopeBytes: binding.envelopeBytesMatch === true,
      envelopeLines: binding.envelopeLinesMatch === true,
      prefixOnLineBoundary: binding.prefixEndsAtLineBoundary === true,
      evidenceComplete: required > 0 && matched === required,
      hashShape: binding.checkpointHashShapeValid === true,
      hashRecomputedByRestore: binding.checkpointHashRecomputedByRestore === true,
      pathClass: binding.pathClassExcludesFixtureAndReplay === true,
    },
  };
}

/**
 * Per-invocation model and turn accounting.
 *
 * The transcript is append-only for the whole arm, and a fork carries the
 * parent's history forward, so a raw transcript total is cumulative, not
 * per-invocation. Two hard-coded `assistantRecords: 1` values in the earlier
 * driver were worse still: they reported a count nothing had measured. Both are
 * replaced by the difference between the transcript total measured after this
 * invocation and the total measured after the previous one.
 *
 * A negative delta is impossible for an append-only transcript, so it is
 * reported rather than clamped: it means the wrong transcript was sampled.
 */
export function transcriptDelta(previous, current) {
  const before = {
    assistantRecords: previous?.assistantRecords ?? 0,
    matchingModelRecords: previous?.matchingModelRecords ?? 0,
    fallbackRecords: previous?.fallbackRecords ?? 0,
  };
  const after = {
    assistantRecords: current?.assistantRecords ?? 0,
    matchingModelRecords: current?.matchingModelRecords ?? 0,
    fallbackRecords: current?.fallbackRecords ?? 0,
  };
  const delta = {
    assistantRecords: after.assistantRecords - before.assistantRecords,
    matchingModelRecords: after.matchingModelRecords - before.matchingModelRecords,
    fallbackRecords: after.fallbackRecords - before.fallbackRecords,
  };
  const models = Object.fromEntries(
    Object.keys({ ...(previous?.counts ?? {}), ...(current?.counts ?? {}) })
      .map((name) => [name, (current?.counts?.[name] ?? 0) - (previous?.counts?.[name] ?? 0)])
      .filter(([, count]) => count !== 0),
  );
  return {
    ...delta,
    counts: models,
    cumulative: after,
    monotonic: delta.assistantRecords >= 0 && delta.matchingModelRecords >= 0 && delta.fallbackRecords >= 0,
  };
}

/** A model reading is credible only if it covers exactly the records it claims. */
export function modelReadingValid(reading) {
  if (reading === null || typeof reading !== "object") return false;
  if (!Number.isInteger(reading.assistantRecords) || reading.assistantRecords < 0) return false;
  if (reading.matchingModelRecords !== reading.assistantRecords) return false;
  const named = Object.values(reading.counts ?? {}).reduce((sum, count) => sum + count, 0);
  return named === reading.assistantRecords;
}

/**
 * Turn the CLI's `--output-format json` `result` text into the object the
 * scorer reads. The neutral probe is asked for one JSON object, so anything
 * else is a refusal rather than a zero score: scoring an empty or malformed body
 * would record a recall of zero for a model that may have answered correctly.
 */
export function materializeProbeResponse(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { response: null, refusal: "empty-probe-result" };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { response: null, refusal: "probe-result-not-json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { response: null, refusal: "probe-result-not-a-json-object" };
  }
  return { response: parsed, refusal: null };
}

/** A score is admissible only if it carries integer points and a denominator. */
export function scoreValid(score) {
  return score !== null && typeof score === "object"
    && Number.isInteger(score.points) && Number.isInteger(score.denominator)
    && score.denominator > 0;
}

/**
 * Remaining-budget tracker for the documented runaway ceiling.
 *
 * The per-arm ceiling is an operational guard, not telemetry: it is checked
 * before every Claude call so a pathological loop stops rather than spending
 * without bound. The advisory figure (0.35 USD) is never passed to the CLI and
 * never blocks a call; it is recorded after the fact.
 *
 * `ceilingUsd` is the hard ceiling, `spentUsd` the observed total so far.
 */
export function createBudget({ ceilingUsd, spentUsd = 0 }) {
  if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0) throw new Error("budget ceiling must be a positive number");
  let spent = spentUsd;
  return {
    remainingUsd: () => ceilingUsd - spent,
    spentUsd: () => spent,
    /** Refuse the next call when the ceiling is already reached. */
    assertCanSpend: (label) => {
      if (spent >= ceilingUsd) {
        throw new Error(`runaway ceiling reached before ${label}: spent ${spent.toFixed(6)} of ${ceilingUsd}`);
      }
      return ceilingUsd - spent;
    },
    record: (usd) => {
      spent += Number.isFinite(usd) && usd > 0 ? usd : 0;
      return spent;
    },
  };
}

/**
 * Count physical lines the way dcompact does: every `\n` terminates a line, and
 * a trailing unterminated line still counts. A plain `split("\n").length` would
 * be off by one for a file without a final newline.
 */
export function physicalLineCount(bytes) {
  let newlines = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) newlines += 1;
  }
  return newlines + (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? 1 : 0);
}

/**
 * A ledger cursor: the number of appended entries observed before an
 * invocation. Assertions inspect only entries added after the cursor, so a
 * phase-2 check cannot see phase-1's treatment and fail falsely.
 */
export function ledgerCursor(rows) {
  return Array.isArray(rows) ? rows.length : 0;
}

/** Rows appended strictly after `cursor`. */
export function rowsAfter(rows, cursor) {
  return Array.isArray(rows) ? rows.slice(cursor) : [];
}

/**
 * Assistant record identities in one transcript.
 *
 * Attribution is by record **identity**, not by counting rows: the authorized
 * Stage-0 evidence has a fork transcript with 4 assistant rows against a source
 * with 30, so subtracting cumulative counts is invalid and goes negative. Every
 * one of those 4 rows carries the fork's session id, so the session id cannot
 * distinguish an inherited record from a new one either — only the record's own
 * identity can.
 *
 * A record without a uuid, or a repeated uuid, makes the reading unusable
 * rather than silently short: an identity set that cannot be trusted cannot
 * attribute anything.
 */
export function assistantIdentities(path) {
  if (!existsSync(path)) {
    return { ids: [], byId: new Map(), assistantRecords: 0, missingUuid: 0, duplicateUuid: 0, usable: false, reason: "transcript-missing" };
  }
  const assistants = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row?.message?.role === "assistant") assistants.push(row);
  }
  const byId = new Map();
  const ids = [];
  let missingUuid = 0;
  let duplicateUuid = 0;
  for (const row of assistants) {
    const id = row.uuid;
    if (typeof id !== "string" || id.length === 0) {
      missingUuid += 1;
      continue;
    }
    if (byId.has(id)) {
      duplicateUuid += 1;
      continue;
    }
    byId.set(id, typeof row.message?.model === "string" ? row.message.model : null);
    ids.push(id);
  }
  const usable = missingUuid === 0 && duplicateUuid === 0;
  return {
    ids,
    byId,
    assistantRecords: assistants.length,
    missingUuid,
    duplicateUuid,
    usable,
    reason: usable ? null : missingUuid > 0 ? "missing-uuid" : "duplicate-uuid",
  };
}

/**
 * Attribute one invocation by the difference between two identity sets.
 *
 * Two relationships exist in this series and they are not interchangeable:
 *
 *  - `fresh-transcript`: the fork's own transcript is a **fresh file** holding a
 *    subset of the source's records plus its own new ones. The measured shape is
 *    4 fork rows against 30 source rows, so `after` legitimately holds far fewer
 *    identities than `before`; a removal check would fire on every real run.
 *  - `append-only`: the probe reads the same fork transcript later, so the file
 *    can only grow. A record present before and absent after is then a real
 *    contradiction and a refusal.
 *
 * In both cases the invocation's work is `after − before`, every counted record
 * must carry the required model, and an identity set that cannot be trusted
 * makes the reading unproven rather than silently short.
 */
export function identityAttribution({ before, after, requiredModel, relationship }) {
  if (!before?.usable || !after?.usable) {
    return {
      assistantRecords: 0,
      matchingModelRecords: 0,
      fallbackRecords: 0,
      counts: {},
      cumulative: null,
      monotonic: true,
      addedIds: [],
      removedIds: [],
      attribution: "unproven",
      proven: false,
      refusal: before?.reason ?? after?.reason ?? "transcript-unavailable",
    };
  }
  const beforeIds = new Set(before.ids);
  const afterIds = new Set(after.ids);
  const addedIds = after.ids.filter((id) => !beforeIds.has(id));
  const removedIds = before.ids.filter((id) => !afterIds.has(id));
  const appendOnly = relationship === "append-only";
  if (appendOnly && removedIds.length > 0) {
    return {
      assistantRecords: addedIds.length,
      matchingModelRecords: 0,
      fallbackRecords: 0,
      counts: {},
      cumulative: null,
      monotonic: false,
      addedIds,
      removedIds,
      attribution: "identity-set-delta",
      proven: false,
      refusal: "records-removed",
    };
  }
  const counts = {};
  let foreign = 0;
  for (const id of addedIds) {
    const model = after.byId.get(id);
    if (model !== requiredModel) {
      foreign += 1;
      continue;
    }
    counts[model] = (counts[model] ?? 0) + 1;
  }
  return {
    assistantRecords: addedIds.length,
    // Records counted here are only the ones that already matched the frozen
    // model, so a foreign record shows up as a mismatch rather than as work.
    matchingModelRecords: addedIds.length - foreign,
    fallbackRecords: foreign,
    counts,
    cumulative: after.assistantRecords,
    monotonic: true,
    addedIds,
    removedIds: appendOnly ? removedIds : [],
    attribution: "identity-set-delta",
    proven: true,
    refusal: null,
  };
}

/**
 * The private run manifest: freeze commit, derived order, and blinding.
 *
 * These values are needed to reconstruct the series, but they must never appear
 * in a public arm artifact: the blinding is what keeps an arm opaque, and the
 * order is derivable only from the freeze commit. Both live here, beside the
 * private artifacts, and are written before any arm runs.
 */
export function runManifest({ freezeCommit, order, series = FROZEN.series }) {
  const derived = order ?? armOrder(freezeCommit);
  return {
    series,
    freezeCommit,
    armOrder: derived,
    blinding: blinding(derived),
    armOrderDerivation: "sort A, B, C by sha256(\"OG86-medium-v1|<freezeCommit>|<arm>\")",
    advisoryTelemetryUsd: FROZEN.advisoryPerArmUsd,
    runawayCeilingUsd: FROZEN.runawayPerArmUsd,
  };
}

/**
 * The CLI's own turn count for one invocation. `num_turns` is reported per
 * process, so unlike a transcript total it is not inherited from a parent
 * session. A non-integer or negative value is not a usable reading.
 */
export function envelopeTurnCount(envelope) {
  const value = envelope?.num_turns;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Read the two seed fields that must agree before an arm may be scored.
 *
 * `protocol.freezeCommit` and `schedule.armOrderSeedCommit` are written at the
 * seed commit S, one commit after the content commit F they name. Until both are
 * non-null and equal, the series is pre-seed and scoring is not authorized.
 */
export function readSeedFields(repository) {
  const benchmark = resolve(repository, "docs/benchmark/og86-medium-v1");
  const read = (name, key) => {
    try {
      return JSON.parse(readFileSync(resolve(benchmark, name), "utf8"))[key] ?? null;
    } catch {
      return null;
    }
  };
  return {
    protocolFreezeCommit: read("protocol.json", "freezeCommit"),
    scheduleArmOrderSeedCommit: read("schedule.json", "armOrderSeedCommit"),
  };
}

/** True when `commit` is a 40-hex lowercase revision that exists locally. */
export function isLocalCommit(repository, commit) {
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) return false;
  // `^{commit}` forces the object to resolve as a commit, not a blob or tag.
  const result = spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`],
    { cwd: repository, encoding: "utf8" });
  return result.status === 0;
}

/**
 * The execute-mode seed gate.
 *
 * Scoring is refused unless a 40-hex local commit exists and exactly equals both
 * non-null seed fields. A pre-seed content state therefore cannot run: the arm
 * order would derive from a commit that does not yet name the frozen inputs.
 */
export function assertSeedReady(repository, requested) {
  const seed = readSeedFields(repository);
  if (seed.protocolFreezeCommit === null || seed.scheduleArmOrderSeedCommit === null) {
    throw new Error("refusing to execute before the seed: protocol.freezeCommit and schedule.armOrderSeedCommit must both be set");
  }
  if (seed.protocolFreezeCommit !== seed.scheduleArmOrderSeedCommit) {
    throw new Error("refusing to execute: protocol.freezeCommit and schedule.armOrderSeedCommit disagree");
  }
  if (!isLocalCommit(repository, seed.protocolFreezeCommit)) {
    throw new Error(`refusing to execute: seed ${seed.protocolFreezeCommit} is not a local commit`);
  }
  if (requested !== undefined && requested !== seed.protocolFreezeCommit) {
    throw new Error("refusing to execute: --freeze-commit does not match the recorded seed");
  }
  return seed.protocolFreezeCommit;
}

/**
 * Refuse a private run root that is a symlink or already holds a run, so a
 * second run cannot silently interleave with the first.
 */
export function assertPrivateRootWritable(privateRoot) {
  let stats = null;
  try {
    stats = lstatSync(privateRoot);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) throw new Error(`refusing to write into a symlinked private root: ${privateRoot}`);
  if (stats.isDirectory() && readdirSync(privateRoot).length > 0) {
    throw new Error(`refusing to write into a non-empty private root: ${privateRoot}`);
  }
}

/**
 * Reduce a mode reading to the sanitized shape a public artifact may carry.
 *
 * Mode tallies and booleans only: no path, no filename, no host detail.
 */
export function sanitizedModes(modes) {
  if (modes === null || modes === undefined || typeof modes !== "object") return null;
  return {
    rootPresent: modes.rootPresent === true,
    readFailureCount: modes.readFailureCount ?? 0,
    directoryModes: modes.directoryModes ?? {},
    fileModes: modes.fileModes ?? {},
    directoryCount: modes.directoryCount ?? 0,
    fileCount: modes.fileCount ?? 0,
    symlinkCount: modes.symlinkCount ?? 0,
    allDirectoriesOwnerOnly: modes.allDirectoriesOwnerOnly === true,
    allFilesOwnerOnly: modes.allFilesOwnerOnly === true,
    zeroSymlinks: modes.zeroSymlinks === true,
  };
}

/**
 * Owner-only mode summary for one arm's private tree.
 *
 * Required evidence at every checkpoint. Modes are collected separately for
 * directories and files — a file under a 0700 directory is not itself 0600 — and
 * a symlink is counted rather than followed, because a link can point outside
 * the tree at material the modes then fail to protect.
 *
 * The summary is sanitized: per-tree mode tallies and booleans, never a path.
 */
export function privateTreeModes(root) {
  const directories = new Map();
  const files = new Map();
  const symlinks = [];
  let readFailureCount = 0;
  let rootPresent = false;
  const walk = (path, depth) => {
    let stats = null;
    try {
      stats = lstatSync(path);
    } catch {
      readFailureCount += 1;
      return;
    }
    if (depth === 0 && !stats.isSymbolicLink() && stats.isDirectory()) rootPresent = true;
    if (stats.isSymbolicLink()) {
      symlinks.push(depth);
      return;
    }
    if (stats.isDirectory()) {
      const mode = (stats.mode & 0o777).toString(8);
      directories.set(mode, (directories.get(mode) ?? 0) + 1);
      let names = [];
      try {
        names = readdirSync(path).sort();
      } catch {
        readFailureCount += 1;
        return;
      }
      for (const name of names) walk(join(path, name), depth + 1);
      return;
    }
    const mode = (stats.mode & 0o777).toString(8);
    files.set(mode, (files.get(mode) ?? 0) + 1);
  };
  walk(root, 0);
  const directoryCount = [...directories.values()].reduce((sum, count) => sum + count, 0);
  const fileCount = [...files.values()].reduce((sum, count) => sum + count, 0);
  // An empty reading must not be describable as owner-only: `[].every(...)` is
  // vacuously true, which would let a tree that was never read publish as clean.
  const measurable = rootPresent && readFailureCount === 0 && directoryCount > 0 && fileCount > 0;
  return {
    rootPresent,
    readFailureCount,
    directoryModes: Object.fromEntries([...directories.entries()].sort()),
    fileModes: Object.fromEntries([...files.entries()].sort()),
    directoryCount,
    fileCount,
    symlinkCount: symlinks.length,
    measurable,
    allDirectoriesOwnerOnly: measurable && [...directories.keys()].every((mode) => mode === "700"),
    allFilesOwnerOnly: measurable && [...files.keys()].every((mode) => mode === "600"),
    zeroSymlinks: symlinks.length === 0,
  };
}

/** Series-level gates: ceilings, compaction count, and the measured covariates. */
export function evaluate(target) {
  for (const arm of target.order) {
    const state = target.arms[arm];
    const manuals = state.checkpoints.filter((entry) => entry.manualCompaction).length;
    if (manuals !== FROZEN.manualCompactionsPerArm) {
      invalidate(target, state, `manual-compaction-count:${manuals}`);
    }
    if (state.checkpoints.length !== FROZEN.phases) {
      invalidate(target, state, `checkpoint-count:${state.checkpoints.length}`);
    }
    for (const entry of state.checkpoints) {
      if (entry.sourceTranscriptStable === false) invalidate(target, state, `source-transcript-changed:${entry.ordinal}`);
    }
    if (state.wallSeconds / 60 > FROZEN.perArmMinutes) invalidate(target, state, "per-arm-wall-clock-limit-exceeded");
    if (state.assistantTurns > FROZEN.assistantTurnsPerArm) invalidate(target, state, "assistant-turn-limit-exceeded");
    if (state.advisoryUsd > FROZEN.runawayPerArmUsd) stopOperationally(target, state, "emergency-runaway-ceiling-reached");
  }
  const seriesWallSeconds = target.order.reduce((sum, arm) => sum + target.arms[arm].wallSeconds, 0);
  const seriesUsd = target.order.reduce((sum, arm) => sum + target.arms[arm].advisoryUsd, 0);
  target.seriesWallSeconds = seriesWallSeconds;
  target.seriesUsd = seriesUsd;
  // Series gates are recorded through the deduplicating helper so repeated
  // evaluation of the same state cannot accumulate duplicate labels.
  if (seriesWallSeconds / 60 > FROZEN.seriesMinutes) push(target, target.invalidations, "series:wall-clock-limit-exceeded");
  if (seriesUsd > FROZEN.advisorySeriesUsd) target.seriesAdvisoryExceeded = true;
  if (seriesUsd > FROZEN.runawaySeriesUsd) push(target, target.operationalStops, "series:emergency-runaway-ceiling-reached");
  target.valid = target.invalidations.length === 0 && target.operationalStops.length === 0;
  return target;
}

/** Cross-arm injected-size covariate. Never a gate in this series. */
export function injectedSizeCovariates(target) {
  const rows = [];
  for (let phase = 1; phase <= FROZEN.phases; phase += 1) {
    const bytes = {};
    for (const arm of target.order) {
      const record = target.arms[arm].checkpoints.find((entry) => entry.ordinal === phase);
      bytes[arm] = record?.treatmentBytes ?? null;
    }
    const ratio = bytes.B && bytes.C ? bytes.C / bytes.B : null;
    rows.push({ ordinal: phase, bytes, ratio });
  }
  return rows;
}

/**
 * Drive the machine. The driver is the only thing that touches the world, so a
 * scripted driver proves ordering and every stop without a model call.
 */
export function runSeries({ driver, order, onObservation }) {
  const state = initialState(order);
  const emit = (arm, observation) => {
    record(state, arm, observation);
    if (onObservation) onObservation(arm, observation, state);
  };
  for (let phase = 1; phase <= FROZEN.phases; phase += 1) {
    state.phase = phase;
    for (const arm of order) {
      state.step = 0;
      const session = driver.openArm(arm, phase);
      const work = driver.sendPhasePrompt({ arm, phase, session });
      emit(arm, { kind: "phase-prompt", phase, ...work });
      const acceptance = driver.runAcceptance({ arm, phase, session });
      emit(arm, { kind: "phase-acceptance", phase, ...acceptance });
      const requested = driver.invokeManualCompact({ arm, phase, session });
      emit(arm, { kind: "compact-requested", phase, ...requested });
      const compact = driver.awaitCompact({ arm, phase, session });
      emit(arm, { kind: "compact-complete", phase, ...compact });
      const summary = driver.captureSummary({ arm, phase, session });
      emit(arm, { kind: "summary-captured", phase, ...summary });
      const fork = driver.createFork({ arm, phase, session });
      emit(arm, { kind: "fork-created", phase, ...fork });
      const probe = driver.probeFork({ arm, phase, session, fork: fork.fork });
      emit(arm, { kind: "fork-probed", phase, ...probe });
      const verified = driver.verifySource({ arm, phase, session });
      emit(arm, { kind: "source-verified", phase, ...verified });
      const resumed = driver.resumeSource({ arm, phase, session });
      emit(arm, { kind: "source-resumed", phase, ...resumed });
      if (state.invalidations.length > 0 || state.operationalStops.length > 0) {
        return { state: evaluate(state), halted: true };
      }
    }
  }
  return { state: evaluate(state), halted: false };
}

/** Sanitized artifact for one arm. Throws rather than emit a partial result. */
export function armArtifact(state, arm, revisions) {
  const record = state.arms[arm];
  if (record.operationalStops.length > 0) {
    throw new Error(`refusing to emit an artifact after an operational stop: ${record.operationalStops.join(",")}`);
  }
  if (state.valid !== true) {
    throw new Error(`refusing to emit an artifact with invalid gates: ${(record.invalidations.length > 0 ? record.invalidations : state.invalidations).join(",")}`);
  }
  if (record.checkpoints.length !== FROZEN.phases) throw new Error("refusing to emit an artifact with missing checkpoints");
  // Required evidence: refuse to publish an arm whose checkpoints lack the
  // owner-only mode summary the protocol lists.
  const badModes = record.checkpoints.filter((entry) => {
    const modes = entry.privateTreeModes;
    if (modes === null || modes === undefined) return true;
    // Meaningful content, not mere presence.
    return modes.rootPresent !== true
      || (modes.readFailureCount ?? 0) !== 0
      || (modes.directoryCount ?? 0) < 1
      || (modes.fileCount ?? 0) < 1
      || modes.symlinkCount !== 0
      || modes.allDirectoriesOwnerOnly !== true
      || modes.allFilesOwnerOnly !== true
      || modes.zeroSymlinks !== true;
  });
  if (badModes.length > 0) {
    throw new Error(`refusing to emit an artifact without meaningful privateTreeModes at checkpoints ${badModes.map((entry) => entry.ordinal).join(",")}`);
  }

  // The B:C ratio is a measured covariate for every arm, never a gate: this
  // series makes no representation claim at any size ratio.
  const covariates = new Map(injectedSizeCovariates(state).map((row) => [row.ordinal, row]));
  const checkpoints = record.checkpoints.map((entry) => {
    const covariate = covariates.get(entry.ordinal);
    return {
      ...entry,
      steps: [...entry.steps],
      treatmentBytes: entry.treatmentBytes ?? 0,
      injectedSizeRatio: covariate?.ratio ?? null,
      crossArmTreatmentBytes: covariate?.bytes ?? null,
    };
  });

  return {
    opaqueArm: state.blinding[arm],
    modelCounts: {
      assistantRecords: record.processes.reduce((sum, process) => sum + (process.assistantRecords ?? 0), 0),
      matchingModelRecords: record.processes.reduce((sum, process) => sum + (process.matchingModelRecords ?? 0), 0),
      fallbackOrModelSwitch: record.processes.reduce((sum, process) => sum + (process.fallbackOrModelSwitchRecords ?? 0), 0),
    },
    processes: record.processes.map((process) => ({ ...process })),
    checkpoints,
    continuation: { manualCompactions: FROZEN.manualCompactionsPerArm },
    invalidations: [...record.invalidations],
    operationalStops: [...record.operationalStops],
    advisoryCostEquivalentUsd: Number(record.advisoryUsd.toFixed(6)),
    pricingSource: "Claude CLI total_cost_usd field from the same process output",
    wallSeconds: record.wallSeconds,
    runnerRevisionDigest: revisions.runner,
    scorerRevisionDigest: revisions.scorer,
  };
}

export function planningDocument(order) {
  return {
    series: FROZEN.series,
    order,
    blinding: blinding(order),
    phases: FROZEN.phases,
    checkpointSequence: CHECKPOINT_SEQUENCE.map((entry) => ({ step: entry.step, role: entry.role })),
    stops: {
      invalidations: [
        "unscheduled or duplicate compaction",
        "model id other than the frozen one",
        "phase acceptance failure",
        "absent, late, duplicated, or oversized treatment",
        "source transcript change during fork creation or probing",
        "probe or continuation tool use",
        "manual-compaction count or order mismatch",
        "wall-clock or assistant-turn ceiling exceeded",
      ],
      operationalStops: FROZEN.operationalStopCodes,
      advisoryOnly: [`per-arm ${FROZEN.advisoryPerArmUsd} USD`, `series ${FROZEN.advisorySeriesUsd} USD`],
    },
  };
}

// ---------------------------------------------------------------------------
// Production driver. Never exercised by the test suite.
// ---------------------------------------------------------------------------

function isDirectExecution() {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  const entry = pathToFileURL(invoked).href;
  if (entry === import.meta.url) return true;
  try {
    return pathToFileURL(resolve(invoked)).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
  } catch {
    return false;
  }
}

export function createClaudeDriver(options) {
  const { repository, privateRoot, dcompact, benchmark, claudeBinary = "claude", model = FROZEN.model } = options;
  const hook = resolve(benchmark, "harness/hook.mjs");
  const prepareArm = resolve(benchmark, "harness/prepare-arm.mjs");
  const prepareScore = resolve(benchmark, "harness/prepare-score-fork.mjs");
  const arms = new Map();
  // One tracker per arm, enforcing the operational runaway ceiling. The
  // advisory figure is never passed to the CLI and never blocks a call.
  const budgets = new Map();

  function budget(arm) {
    if (!budgets.has(arm)) budgets.set(arm, createBudget({ ceilingUsd: FROZEN.runawayPerArmUsd }));
    return budgets.get(arm);
  }

  function run(command, args, runOptions = {}) {
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...runOptions });
    if (result.error || result.status !== 0) {
      throw new Error(`${command} failed with status ${result.status}; stderr_bytes=${Buffer.byteLength(result.stderr || "")}`);
    }
    return result.stdout;
  }

  /**
   * Run one Claude invocation. The ceiling is checked before spawning and the
   * remaining allowance is passed as the call's own budget, so neither the
   * tracker nor a single runaway call can exceed the documented 5 USD per-arm
   * runaway limit. The advisory 0.35 USD figure is never passed to the CLI: it
   * is telemetry recorded after the fact, and using it as a call budget would
   * abort legitimate arms.
   *
   * A zero exit status is not success on its own: the CLI reports `is_error`
   * inside the JSON envelope, so a parsed `is_error === true` is a refusal.
   */
  function callClaude(arm, args, cwd, outputPath) {
    const remaining = budget(arm).assertCanSpend(`${arm} ${outputPath}`);
    // The remaining ceiling is passed to the CLI as well, so one runaway call
    // cannot exceed it even before the next pre-call check. No callsite passes
    // its own budget: a per-call figure at the advisory level would abort
    // legitimate arms, which is exactly the defect this replaces.
    const guarded = [...args, "--max-budget-usd", remaining.toFixed(6)];
    // Anything the agent creates during this call must land owner-only, so the
    // child runs under a restrictive umask for its whole lifetime.
    const result = spawnPrivateChild(claudeBinary, guarded, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const stdout = result.stdout || "";
    writeFileSync(outputPath, stdout, { mode: 0o600 });
    writeFileSync(`${outputPath}.stderr`, result.stderr || "", { mode: 0o600 });
    chmodSync(outputPath, 0o600);
    chmodSync(`${outputPath}.stderr`, 0o600);
    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
    if (result.error || result.status !== 0) {
      throw new Error(`claude failed: status=${result.status}, stderr_bytes=${Buffer.byteLength(result.stderr || "")}`);
    }
    if (parseError !== null) {
      throw new Error(`claude returned an unparseable envelope: ${parseError}`);
    }
    // A successful envelope is a non-array object. An array, null, or a bare
    // primitive parses cleanly but carries no fields, so accepting it would let
    // a malformed call read as a successful one.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`claude envelope is not an object: ${Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed}`);
    }
    if (parsed.is_error !== false) {
      throw new Error(`claude reported is_error=${parsed.is_error ?? "missing"}: subtype=${parsed.subtype ?? "unknown"}, api_error_status=${parsed.api_error_status ?? "none"}`);
    }
    // Cost must be a finite, non-negative number; the tracker cannot police a
    // ceiling against NaN or a missing figure.
    if (typeof parsed.total_cost_usd !== "number" || !Number.isFinite(parsed.total_cost_usd) || parsed.total_cost_usd < 0) {
      throw new Error(`claude reported an invalid total_cost_usd: ${JSON.stringify(parsed.total_cost_usd ?? null)}`);
    }
    budget(arm).record(parsed.total_cost_usd);
    return parsed;
  }

  function common(settingsPath, tools) {
    return ["-p", "--settings", settingsPath, "--setting-sources", "", "--model", model,
      "--autocompact", "1M", "--dangerously-skip-permissions", "--tools", tools, "--output-format", "json"];
  }

  function transcriptModels(path) {
    const counts = {};
    let assistantRecords = 0;
    let fallbackRecords = 0;
    if (!existsSync(path)) return { assistantRecords, counts, fallbackRecords, matchingModelRecords: 0 };
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const recorded = row?.message?.role === "assistant" ? row.message.model : null;
      if (typeof recorded === "string") {
        assistantRecords += 1;
        counts[recorded] = (counts[recorded] ?? 0) + 1;
      }
      if (/fallback|model.switch/i.test(String(row?.type ?? ""))) fallbackRecords += 1;
    }
    const matchingModelRecords = counts[model] ?? 0;
    return { assistantRecords, counts, fallbackRecords, matchingModelRecords };
  }

  function privateDirectory(path) {
    privateDirectoryOf(path);
  }

  function session(arm) {
    const entry = arms.get(arm);
    if (entry === undefined) throw new Error(`arm ${arm} has no open session`);
    return entry;
  }

  function digestOf(path) {
    return sha256(readFileSync(path));
  }

  /**
   * The source's own transcript.
   *
   * `transcript-path.txt` in the arm root is written by every SessionStart the
   * hook sees, including the fork's. Reading that file after a fork would
   * therefore point at the fork's transcript and silently compare the wrong
   * file. The source path is captured once, when the source session is created,
   * and every subsequent read goes through it.
   */
  function sourceTranscriptPath(entry) {
    return requireSourceTranscriptPath(entry);
  }

  /**
   * The fork transcript the hook reported for one checkpoint.
   *
   * After `--fork-session` the hook rewrites the shared transcript record to
   * name the new fork, so the actual fork path is only knowable by reading the
   * record at that moment and persisting it by fork id and checkpoint. The
   * probe then reads the persisted path rather than whatever the shared record
   * happens to say later.
   */
  function forkRecordPath(entry, phase) {
    return resolve(entry.root, `phase-${phase}-fork-transcript.txt`);
  }

  /**
   * Persist the fork record for one checkpoint.
   *
   * Delegates to the module-scope implementation so the driver and the offline
   * tests exercise exactly one definition.
   */
  function persistForkTranscript(entry, phase, forkId, forkTranscriptPath, baseline) {
    const record = persistForkRecord(entry.root, phase, forkId, forkTranscriptPath, baseline);
    writeFileSync(forkRecordPath(entry, phase), `${forkTranscriptPath}\n`, { mode: 0o600 });
    return record;
  }

  function readForkRecord(entry, phase) {
    try {
      return JSON.parse(readFileSync(resolve(entry.root, `phase-${phase}-fork.json`), "utf8"));
    } catch {
      return null;
    }
  }

  function frozenBaseline(record, { phase, fork }) {
    return frozenBaselineOf(record, { phase, fork });
  }

  /** Every hook audit row this arm has recorded so far. */
  function readLedger(entry) {
    const path = resolve(entry.root, "events.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  }

  function sourceSnapshot(entry) {
    const bytes = readFileSync(sourceTranscriptPath(entry));
    // Physical lines: a trailing unterminated line still counts, matching
    // dcompact's own line accounting.
    return { bytes: bytes.byteLength, lines: physicalLineCount(bytes), sha256: sha256(bytes) };
  }

  /**
   * Labeled roots for every forbidden location class.
   *
   * The transcript and profile roots mirror what the hook itself derives from
   * the host-reported transcript path: a transcript at
   * `<profile>/projects/<slug>/<id>.jsonl` puts the profile root at the ancestor
   * holding `projects`. Deriving them the same way is what makes the matrix's
   * class check meaningful — otherwise the driver would probe a synthetic path
   * the hook never classifies, and every row would fail for the wrong reason.
   *
   * The transcript is nested inside the profile, which is the overlap the
   * most-specific-first ordering exists to resolve.
   */
  function forbiddenEntries(entry) {
    const transcript = existsSync(resolve(entry.root, "source-transcript-path.txt"))
      ? readFileSync(resolve(entry.root, "source-transcript-path.txt"), "utf8").trim()
      : resolve(entry.root, "transcript");
    const segments = transcript.split(sep);
    const marker = segments.lastIndexOf("projects");
    const profile = marker > 0 ? segments.slice(0, marker).join(sep) : entry.root;
    return {
      transcript: { path: transcript, kind: "file" },
      profile: { path: profile, kind: "directory" },
      store: { path: resolve(entry.root, "store"), kind: "directory" },
      rubric: { path: resolve(benchmark, "rubric.json"), kind: "file" },
      scorer: { path: resolve(repository, "scripts/benchmark/score-og86.mjs"), kind: "file" },
      capture: { path: resolve(entry.root, "sessions"), kind: "directory" },
    };
  }

  function forbiddenFlags(entry) {
    return Object.entries(forbiddenEntries(entry)).map(([label, value]) => `--forbid${label}=${value.path}`);
  }

  /**
   * The `--output-format json` envelope carries the assistant's text in
   * `result`. The neutral probe is asked for one JSON object, so the response is
   * materialised from that field, and a non-object body fails closed rather
   * than being scored as an empty response.
   */
  function probeResponse(entry, phase, cliOutput) {
    const text = typeof cliOutput.result === "string" ? cliOutput.result : "";
    const result = materializeProbeResponse(text);
    if (result.refusal !== null) {
      writeFileSync(resolve(entry.root, `phase-${phase}-neutral-response.refusal.json`),
        `${JSON.stringify({ phase, reason: result.refusal, textBytes: Buffer.byteLength(text) })}\n`, { mode: 0o600 });
      return { response: null, refusal: result.refusal };
    }
    // Persist the object the scorer reads, so the score is recomputable.
    const path = resolve(entry.root, `phase-${phase}-neutral-response.json`);
    writeFileSync(path, `${JSON.stringify(result.response, null, 2)}\n`, { mode: 0o600 });
    return { response: path, refusal: null };
  }

  /** Score the materialised response, or return null when it was refused. */
  function scoreProbe(entry, phase, responsePath) {
    if (responsePath === null) return null;
    const output = run(process.execPath, [resolve(repository, "scripts/benchmark/score-og86.mjs"),
      "--atoms", resolve(benchmark, "atoms.json"), "--response", responsePath, "--checkpoint", String(phase)]);
    const score = JSON.parse(output);
    if (!scoreValid(score)) throw new Error(`phase ${phase}: scorer returned a malformed result`);
    return score;
  }

  /**
   * The transcript is cumulative and a fork carries the parent's history, so
   * every reading is a per-invocation delta from the previous total.
   */
  function readModels(entry, transcriptPath) {
    const current = transcriptModels(transcriptPath);
    const delta = transcriptDelta(entry.previousModels, current);
    entry.previousModels = current;
    return { current, delta };
  }

  /**
   * Run every probe against the real hook and record the observed verdict *and*
   * the class the hook actually reported.
   *
   * The verdict alone is not evidence: a claimed `read-transcript` probe that
   * the hook denied as `outside`, or as `profile`, has the right answer for the
   * wrong reason, and a matrix that only compares allow/deny cannot tell the
   * difference.
   */
  function observeMatrix(entry) {
    const classes = forbiddenEntries(entry);
    const missing = requiredLocationClasses().filter((label) => classes[label] === undefined);
    if (missing.length > 0) throw new Error(`no forbidden root declared for: ${missing.join(",")}`);
    const probes = probeMatrix({ workloadRoot: entry.workload, forbidden: classes });
    const rows = [];
    for (const probe of probes) {
      const cursor = ledgerCursor(readLedger(entry));
      const body = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: probe.tool, tool_input: probe.input });
      const started = process.hrtime.bigint();
      const output = spawnSync(process.execPath, [hook, "--event", "PreToolUse", "--arm", entry.arm, "--state", entry.root,
        "--workload", entry.workload, "--dcompact", dcompact, ...forbiddenFlags(entry)], { input: body, encoding: "utf8" });
      const parsed = JSON.parse(output.stdout || "{}").hookSpecificOutput;
      const decided = parsed?.permissionDecision;
      // The hook's own audit row is the observation, not a re-derivation here.
      const row = rowsAfter(readLedger(entry), cursor).find((item) => item.kind === "PreToolUse") ?? {};
      rows.push({
        name: probe.name,
        capability: probe.capability,
        location: probe.location,
        expected: probe.expected,
        decision: decided ?? "missing",
        allowed: decided === "allow",
        observedClass: row.location ?? "unreported",
        reason: row.reason ?? parsed?.permissionDecisionReason ?? "unreported",
        elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
      });
    }
    return rows;
  }

  return {
    openArm(arm, phase) {
      if (arms.has(arm)) return session(arm).sessionId;
      const root = resolve(privateRoot, `arm-${arm.toLowerCase()}`);
      privateDirectory(root);
      const workload = resolve(root, "workload");
      // Each arm works on its own copy of the frozen base: the arms must not
      // observe each other's edits, and the base stays byte-identical. The copy
      // is then made owner-only, and the tree is built under a restrictive umask
      // so anything created later inherits 0700/0600.
      withRestrictiveUmask(() => {
        cpSync(resolve(benchmark, "workload"), workload, { recursive: true, errorOnExist: true });
        makeTreePrivate(root);
      });
      const settings = run(process.execPath, [prepareArm, "--arm", arm, "--private-root", root,
        "--workload", workload, "--dcompact", dcompact, "--benchmark", benchmark]).trim();
      writeFileSync(resolve(root, "forbidden-canary.txt"), `PRIVATE-OG86-CANARY-${arm}\n`, { mode: 0o600 });
      arms.set(arm, {
        arm, root, workload, settings, phase,
        sessionId: null,
        previousModels: null,
        // Pinned when the source session is created; never re-read from the
        // shared transcript-path.txt, which a fork also overwrites.
        sourceTranscriptPath: null,
      });
      return null;
    },
    sendPhasePrompt({ arm, phase }) {
      const entry = session(arm);
      const prompts = JSON.parse(readFileSync(resolve(benchmark, "phase-prompts.json"), "utf8"));
      const prompt = prompts.find((row) => row.phase === phase).prompt;
      // The phase prompt is a resume of the live source. Treatment must not
      // reach it, so nothing is armed here.
      const started = process.hrtime.bigint();
      const identity = entry.sessionId === null ? ["--session-id", randomUUID()] : ["--resume", entry.sessionId];
      const output = callClaude(arm, [...common(entry.settings, "Read,Edit,Write,Glob,Grep,Bash"), ...identity, prompt],
        entry.workload, resolve(entry.root, `phase-${phase}-work.json`));
      entry.sessionId = output.session_id;
      writeFileSync(resolve(entry.root, "session-id.txt"), `${entry.sessionId}\n`, { mode: 0o600 });
      // The source session exists now, and the hook has reported its transcript.
      // Pin it before any fork can overwrite the shared record.
      if (entry.sourceTranscriptPath === null) {
        const reported = readFileSync(resolve(entry.root, "transcript-path.txt"), "utf8").trim();
        entry.sourceTranscriptPath = reported;
        writeFileSync(resolve(entry.root, "source-transcript-path.txt"), `${reported}\n`, { mode: 0o600 });
      }
      const models = readModels(entry, sourceTranscriptPath(entry));
      return {
        costUsd: Number(output.total_cost_usd ?? 0),
        wallSeconds: Number(process.hrtime.bigint() - started) / 1e9,
        turns: models.delta.assistantRecords,
        models: models.delta,
      };
    },
    runAcceptance({ arm }) {
      const entry = session(arm);
      // The acceptance run is wall-clock work like any other step, so it is
      // measured: a ceiling that ignored `npm test` would under-count the arm.
      const started = process.hrtime.bigint();
      const result = spawnSync("npm", ["test"], { cwd: entry.workload, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      return {
        passed: result.status === 0,
        wallSeconds: Number(process.hrtime.bigint() - started) / 1e9,
      };
    },
    invokeManualCompact({ arm }) {
      void arm;
      return { trigger: "manual" };
    },
    awaitCompact({ arm, phase }) {
      const entry = session(arm);
      // `/compact` is also a resume of the live source, so it must inject zero
      // treatment. Nothing is armed for it.
      const started = process.hrtime.bigint();
      // Cursor taken before the call: only rows this invocation appends are
      // inspected, so phase 2 cannot see phase 1's treatment.
      const cursor = ledgerCursor(readLedger(entry));
      const output = callClaude(arm, [...common(entry.settings, ""), "--resume", entry.sessionId, "/compact"],
        entry.workload, resolve(entry.root, `phase-${phase}-compact.json`));
      const appended = rowsAfter(readLedger(entry), cursor);
      const post = appended.find((row) => row.kind === "PostCompact");
      if (post === undefined) throw new Error(`phase ${phase}: PostCompact not observed in this invocation`);
      const injected = appended.filter((row) => row.kind === "Treatment" && (row.treatmentBytes ?? 0) > 0);
      if (injected.length > 0) {
        throw new Error(`phase ${phase}: compact resume injected ${injected.length} treatment(s)`);
      }
      const models = readModels(entry, sourceTranscriptPath(entry));
      return {
        costUsd: Number(output.total_cost_usd ?? 0),
        wallSeconds: Number(process.hrtime.bigint() - started) / 1e9,
        turns: models.delta.assistantRecords,
        treatmentBytes: 0,
        models: models.delta,
      };
    },
    captureSummary({ arm }) {
      const entry = session(arm);
      const summaryPath = resolve(entry.root, "native-summary.txt");
      return { bytes: statSync(summaryPath).size, sha256: digestOf(summaryPath) };
    },
    createFork({ arm, phase }) {
      const entry = session(arm);
      const before = sourceSnapshot(entry);
      // The fork is created from the live source, so it inherits the parent's
      // history; nothing is armed, and a treatment here would be inherited and
      // injected again on the probe resume.
      const started = process.hrtime.bigint();
      const cursor = ledgerCursor(readLedger(entry));
      // The pre-fork source identity set, read before the call. Attribution is
      // by record identity, not by counting rows: the fork's own transcript has
      // far fewer rows than the source, and all of them carry the fork's session
      // id, so neither a count nor a session id can separate inherited records
      // from the fork's own.
      const sourceIdentitiesBefore = assistantIdentities(sourceTranscriptPath(entry));
      const output = callClaude(arm, [...common(entry.settings, ""), "--resume", entry.sessionId, "--fork-session", "/status"],
        entry.workload, resolve(entry.root, "fork.json"));
      const appended = rowsAfter(readLedger(entry), cursor);
      const injected = appended.filter((row) => row.kind === "Treatment" && (row.treatmentBytes ?? 0) > 0);
      if (injected.length > 0) throw new Error(`fork creation injected ${injected.length} treatment(s)`);

      // The hook's SessionStart for this fork rewrote the shared transcript
      // record to name the fork. That is the only place the fork path appears.
      const forkTranscriptPath = existsSync(resolve(entry.root, "transcript-path.txt"))
        ? readFileSync(resolve(entry.root, "transcript-path.txt"), "utf8").trim()
        : null;
      if (forkTranscriptPath === null) throw new Error(`phase ${phase}: fork transcript path was not reported`);
      if (forkTranscriptPath === sourceTranscriptPath(entry)) {
        throw new Error(`phase ${phase}: fork transcript path matches the source`);
      }
      // What the fork produced during creation, by identity against the
      // pre-fork source set. This set is frozen into the record below and is the
      // only baseline the probe is allowed to use.
      const forkIdentitiesAfterCreation = assistantIdentities(forkTranscriptPath);
      persistForkTranscript(entry, phase, output.session_id, forkTranscriptPath, forkIdentitiesAfterCreation);
      const creation = identityAttribution({
        before: sourceIdentitiesBefore,
        after: forkIdentitiesAfterCreation,
        requiredModel: model,
        // The fork's transcript is its own fresh file, so it holds a subset of
        // the source's records plus its own additions. Removals are expected.
        relationship: "fresh-transcript",
      });
      // The source cursor is deliberately untouched: the fork's work is not the
      // source's, and advancing the cursor here would hide the source's own next
      // invocation.
      return {
        fork: output.session_id,
        distinct: output.session_id !== entry.sessionId,
        source: before,
        forkTranscriptPath,
        baselineIds: forkIdentitiesAfterCreation.ids,
        baselineUsable: forkIdentitiesAfterCreation.usable,
        costUsd: Number(output.total_cost_usd ?? 0),
        wallSeconds: Number(process.hrtime.bigint() - started) / 1e9,
        turns: creation.assistantRecords,
        models: creation,
      };
    },
    probeFork({ arm, phase, fork }) {
      const entry = session(arm);
      const treatment = arm === "A" ? "EMPTY"
        : arm === "B" ? resolve(entry.root, "native-summary.txt")
          : resolve(entry.root, `phase-${phase}-pack.txt`);
      if (arm === "C") {
        const pack = run(process.execPath, [dcompact, "restore", "--session", entry.sessionId, "--store", resolve(entry.root, "store")]);
        writeFileSync(treatment, pack, { mode: 0o600 });
      }
      const probeRoot = resolve(entry.root, `phase-${phase}-probe`);
      privateDirectory(probeRoot);
      const prepared = JSON.parse(run(process.execPath, [prepareScore, "--private-root", probeRoot, "--treatment", treatment]));
      // The baseline is the fork's identity set as captured right after fork
      // creation, persisted by fork id and checkpoint. It is not re-derived from
      // the shared transcript record, which a later SessionStart could rewrite.
      // The frozen baseline from the creation record, validated field by field.
      // Re-reading the fork file here would let anything appended between
      // creation and probing count as inherited rather than as the probe's work.
      const forkRecord = readForkRecord(entry, phase);
      const baseline = frozenBaseline(forkRecord, { phase, fork });
      const started = process.hrtime.bigint();
      const output = callClaude(arm, [...common(prepared.settingsPath, ""), "--resume", fork,
        "Without tools, return one JSON object describing the current objective, files and symbols, requirements, decisions, negative constraints, errors with causes and fixes, command and test outcomes, unresolved items, and the next action. State uncertainty instead of guessing."],
      entry.workload, resolve(probeRoot, "probe.json"));
      const events = readFileSync(resolve(probeRoot, "score-fork-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const copies = events.filter((row) => row.event === "SessionStart" && row.treatmentBytes > 0).length;
      const toolDecisions = events.filter((row) => row.event === "PreToolUse");
      // Materialise the model's JSON into the exact object the scorer reads.
      const materialised = probeResponse(entry, phase, output);
      const score = scoreProbe(entry, phase, materialised.response);
      // Attribution by identity against the persisted creation baseline, read
      // from the same fork transcript the baseline came from.
      const after = assistantIdentities(forkRecord.forkTranscriptPath);
      const models = identityAttribution({
        before: baseline,
        after,
        requiredModel: model,
        // Same fork transcript as the baseline, read later: append-only.
        relationship: "append-only",
      });
      // `num_turns` only corroborates the transcript's own count; it can never
      // supply model identity, so it is recorded rather than substituted.
      const corroboratingTurns = envelopeTurnCount(output);
      return {
        treatmentBytes: prepared.treatmentBytes,
        treatmentSha256: prepared.expectedSha256,
        treatmentCopies: copies,
        toolDecisions,
        score,
        scoreRefusal: materialised.refusal,
        baselineAssistantRecords: baseline.assistantRecords,
        corroboratingTurns,
        corroboratesTranscriptCount: corroboratingTurns === null ? null : corroboratingTurns === models.assistantRecords,
        wallSeconds: Number(process.hrtime.bigint() - started) / 1e9,
        turns: models.assistantRecords,
        models,
      };
    },
    verifySource({ arm }) {
      const entry = session(arm);
      // Measured, never a literal: `wallSeconds` is published evidence and feeds
      // the per-arm ceiling, so a constant would both misreport the arm and hide
      // a slow verification from the ceiling.
      const started = process.hrtime.bigint();
      const source = sourceSnapshot(entry);
      const canary = resolve(entry.root, "forbidden-canary.txt");
      const canaryValue = existsSync(canary) ? readFileSync(canary, "utf8").trim() : "";
      const transcript = readFileSync(sourceTranscriptPath(entry), "utf8");
      const canaryOccurrenceCount = canaryValue.length === 0 ? 0 : transcript.split(canaryValue).length - 1;
      const privateModes = privateTreeModes(entry.root);
      return {
        source,
        canaryOccurrenceCount,
        privateTreeModes: privateModes,
        wallSeconds: Number(process.hrtime.bigint() - started) / 1e9,
      };
    },
    resumeSource({ arm, phase }) {
      const entry = session(arm);
      const token = `${arm}-${phase}-${randomUUID()}`;
      const armed = arm === "A" ? null : JSON.parse(run(process.execPath, [hook,
        "--arm-treatment", token, "--treatment-arm", arm, "--treatment-checkpoint", String(phase),
        "--state", entry.root])).armed;
      const started = process.hrtime.bigint();
      const cursor = ledgerCursor(readLedger(entry));
      callClaude(arm, [...common(entry.settings, "Read,Edit,Write,Glob,Grep,Bash"), "--resume", entry.sessionId,
        "Continue with the single highest-priority unfinished item. Preserve prior constraints, implement it, and run the relevant tests."],
      entry.workload, resolve(entry.root, `phase-${phase}-resume.json`));
      if (arm !== "A" && armed !== null) {
        // Confirm the arming was consumed by this resume rather than left armed.
        const ledger = JSON.parse(run(process.execPath, [hook,
          "--arm-treatment", token, "--treatment-arm", arm, "--treatment-checkpoint", String(phase),
          "--state", entry.root, "--await-treatment=true", "--await-timeout-ms", "2000"]));
        if (ledger.injected !== true) {
          // An unconsumed arming means the resume did not inject; re-arm so the
          // next resume can, and let the arm-level gate record the consequence.
          writeFileSync(resolve(entry.root, `phase-${phase}-unconsumed-arming.json`), `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
        }
      }
      // The treatment this resume actually received, from the hook's own ledger,
      // restricted to rows this invocation appended.
      const injection = rowsAfter(readLedger(entry), cursor).reverse().find((row) => row.kind === "Treatment"
        && row.armed === true && row.token === token && (row.treatmentBytes ?? 0) > 0);
      const models = readModels(entry, sourceTranscriptPath(entry));
      return {
        treatmentBytes: injection?.treatmentBytes ?? 0,
        treatmentSha256: injection?.treatmentSha256 ?? null,
        treatmentCopies: injection === undefined ? 0 : 1,
        treatmentToken: token,
        toolProbes: observeMatrix(entry),
        binding: arm === "C" ? armBinding(entry, { dcompact }) : null,
        wallSeconds: Number(process.hrtime.bigint() - started) / 1e9,
        turns: models.delta.assistantRecords,
        models: models.delta,
      };
    },
  };
}

/**
 * The checkpoint the arm C pack was produced from: bound to the transcript, and
 * verified by running dcompact's own `restore`, which re-derives the payload
 * hash and refuses a corrupt checkpoint. A refused restore is recorded, not
 * silently treated as a shape check.
 */
export function armBinding(entry, { dcompact }) {
  // The pinned source transcript: the shared record can name the fork by now.
  const transcriptPath = requireSourceTranscriptPath(entry);
  const directory = resolve(entry.root, "store", "claude", entry.sessionId, "checkpoints");
  const names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  const latest = JSON.parse(readFileSync(resolve(directory, names[names.length - 1]), "utf8"));
  return restoreVerifiedBinding({
    transcriptPath,
    checkpoint: latest,
    restore: () => {
      const result = spawnSync(process.execPath, [dcompact, "restore", "--session", entry.sessionId,
        "--store", resolve(entry.root, "store")], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      const refusalCode = result.status === 0 ? null : (/corrupt-checkpoint/.test(result.stderr || "") ? "corrupt-checkpoint" : "restore-failed");
      return { status: result.status, pack: result.stdout, refusalCode, detail: (result.stderr || "").trim().slice(0, 200) };
    },
  });
}

/**
 * The pinned source transcript path for an arm.
 *
 * The arm's `transcript-path.txt` is rewritten by every SessionStart the hook
 * observes, including the score fork's, so reading it after a fork can silently
 * return the fork's transcript. The source path is captured once, when the
 * source session is created, and every source read goes through it.
 */
export function requireSourceTranscriptPath(entry) {
  const path = entry?.sourceTranscriptPath;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`arm ${entry?.arm ?? "unknown"}: source transcript path was never captured`);
  }
  return path;
}

/**
 * Re-hydrate a persisted baseline into the shape `identityAttribution` reads.
 *
 * Validation is deliberately strict and fails closed: a record whose phase,
 * fork id, path, digest, count, or uuid uniqueness does not hold is refused
 * rather than used as a loose baseline.
 */
export function frozenBaselineOf(record, { phase, fork }) {
    const fail = (reason) => {
      throw new Error(`phase ${phase}: fork baseline ${reason}`);
    };
    if (record === null || typeof record !== "object") return fail("record is missing");
    if (!Number.isInteger(record.phase) || record.phase < 1 || record.phase > 4) return fail("phase is not 1..4");
    if (record.phase !== phase) return fail("phase does not match the checkpoint");
    if (typeof record.forkId !== "string" || record.forkId.length === 0) return fail("fork id is missing");
    if (record.forkId !== fork) return fail("fork id does not match the created fork");
    if (typeof record.forkTranscriptPath !== "string" || record.forkTranscriptPath.length === 0) {
      return fail("transcript path is missing");
    }
    const baseline = record.baseline;
    if (baseline === null || typeof baseline !== "object") return fail("baseline is missing");
    if (!Array.isArray(baseline.ids)) return fail("baseline ids are missing");
    if (baseline.usable !== true) return fail(`baseline is unusable (${baseline.reason ?? "unknown"})`);
    if (baseline.ids.some((id) => typeof id !== "string" || id.length === 0)) return fail("baseline has a non-string id");
    if (new Set(baseline.ids).size !== baseline.ids.length) return fail("baseline ids are not unique");
    if (!Number.isInteger(baseline.count) || baseline.count !== baseline.ids.length) {
      return fail("baseline count does not match its ids");
    }
    const models = baseline.models;
    if (models === null || typeof models !== "object" || Array.isArray(models)) return fail("baseline models are missing");
    const pairs = baseline.ids.map((id) => [id, models[id] ?? null]);
    if (sha256(JSON.stringify(pairs)) !== baseline.digest) return fail("baseline digest does not match its ids");
    const byId = new Map(pairs);
    return { ids: [...baseline.ids], byId, assistantRecords: baseline.count, usable: true, reason: null };
  }

/**
 * Exported seams for the offline test suite.
 *
 * These wrap behaviours that live inside `createClaudeDriver` (where they need
 * the arm's root) so a test can exercise them without a model call or a run.
 */
export function persistForkRecord(root, phase, forkId, forkTranscriptPath, baseline) {
  const baselinePairs = baseline.ids.map((id) => [id, baseline.byId.get(id) ?? null]);
  const record = {
    phase,
    forkId,
    forkTranscriptPath,
    baseline: {
      ids: baseline.ids,
      models: Object.fromEntries(baselinePairs),
      digest: sha256(JSON.stringify(baselinePairs)),
      count: baseline.assistantRecords,
      usable: baseline.usable,
      missingUuid: baseline.missingUuid,
      duplicateUuid: baseline.duplicateUuid,
      reason: baseline.reason,
    },
  };
  writeFileSync(resolve(root, `phase-${phase}-fork.json`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export const __persistForkRecord = persistForkRecord;
export const __frozenBaseline = frozenBaselineOf;

/**
 * Recursively make a tree owner-only: directories 0700, files 0600.
 *
 * `cpSync` preserves the source modes, and the tracked workload is 0644 files
 * in 0755 directories, so a copied tree is not owner-only by default. The mode
 * gate then fails on the first real arm. Symlinks are unlinked rather than
 * followed so a link cannot point the chmod at something outside the tree.
 */
export function makeTreePrivate(root) {
  let stats = null;
  try {
    stats = lstatSync(root);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink()) return false;
  if (stats.isDirectory()) {
    chmodSync(root, 0o700);
    for (const name of readdirSync(root).sort()) makeTreePrivate(join(root, name));
    return true;
  }
  chmodSync(root, 0o600);
  return true;
}

/**
 * Run a function with a restrictive umask, restoring the previous value.
 *
 * Child processes inherit the umask, so anything Claude or a tool creates during
 * the arm is owner-only without relying on the child to set modes itself. The
 * restore runs in `finally` so a throw cannot leave the controller's umask
 * changed for the rest of the process.
 */
export function withRestrictiveUmask(fn) {
  const previous = process.umask(0o077);
  try {
    return fn();
  } finally {
    process.umask(previous);
  }
}

/**
 * Spawn a child synchronously with a restrictive umask in force.
 *
 * A child inherits the parent's umask at fork time, and the umask is what masks
 * the modes the child asks for. The agent's own tools create files without
 * naming a mode, so the umask is the *only* thing that decides whether a file
 * the agent writes during a call lands 0600 or 0644. Setting it around the
 * `spawnSync` keeps it in force for the child's whole lifetime — `spawnSync`
 * does not return until the child has exited — and `withRestrictiveUmask`
 * restores the parent's value in `finally`, so a throw cannot leave the
 * controller's umask changed for the rest of the process.
 *
 * This is the single mechanism both runners use, so a call site cannot be
 * forgotten in one of them.
 */
export function spawnPrivateChild(command, args, options) {
  return withRestrictiveUmask(() => spawnSync(command, args, options));
}

/** Owner-only directory, module scope so `main` and the driver agree. */
function privateDirectoryOf(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function main() {
  const argv = process.argv.slice(2);
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  const repository = process.cwd();
  const benchmark = resolve(repository, "docs/benchmark/og86-medium-v1");
  const freezeCommit = value("--freeze-commit");
  const dryRun = argv.includes("--dry-run") || !argv.includes("--execute");

  if (dryRun) {
    // Dry-run is model-free and explicitly pre-seed: it prints the shape of a
    // run without claiming a seed exists, and needs no commit to do so.
    const seed = readSeedFields(repository);
    const checkpointSequence = CHECKPOINT_SEQUENCE.map((entry) => ({ step: entry.step, role: entry.role }));
    const plan = freezeCommit === undefined
      ? { series: FROZEN.series, preSeed: true, checkpointSequence, seed }
      : { ...planningDocument(armOrder(freezeCommit)), preSeed: seed.protocolFreezeCommit === null, seed };
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  // Execute mode. The order derives from the recorded seed, never from a flag.
  const seedCommit = assertSeedReady(repository, freezeCommit);
  const order = armOrder(seedCommit);
  const privateRoot = resolve(value("--private-root") ?? "sessions/og86-medium-current");
  // The freeze commit, derived order, and blinding live in a private manifest
  // beside the arm artifacts. They must not enter a public arm artifact: the
  // blinding is what keeps an arm opaque, and the order is derivable only from
  // the freeze commit. Written before any arm runs, so a crash still leaves the
  // series reconstructable.
  // Refuse a symlinked or already-populated private root before writing anything.
  assertPrivateRootWritable(privateRoot);
  privateDirectoryOf(privateRoot);
  const manifestPath = resolve(privateRoot, "run-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(runManifest({ freezeCommit: seedCommit, order }), null, 2)}\n`, { mode: 0o600 });
  const driver = createClaudeDriver({ repository, benchmark, privateRoot, dcompact: resolve(repository, "dist/cli.js") });
  const result = runSeries({ driver, order });
  const revisions = {
    runner: sha256(readFileSync(fileURLToPath(import.meta.url))),
    scorer: sha256(readFileSync(resolve(repository, "scripts/benchmark/score-og86.mjs"))),
  };
  const artifacts = order.map((arm) => armArtifact(result.state, arm, revisions));
  for (const artifact of artifacts) {
    const path = resolve(privateRoot, "arms", `${artifact.opaqueArm}.json`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({
    valid: result.state.valid,
    manifest: manifestPath,
    artifacts: artifacts.map((entry) => entry.opaqueArm),
  })}\n`);
}

if (isDirectExecution()) main();
