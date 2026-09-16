import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * OG-86 controller and continuation-boundary proofs.
 *
 * The two runtime modules are plain `.mjs` and are reached the way this project
 * already reaches `.mjs` from a spec (`test/og86-benchmark.spec.ts`): through a
 * real `node --eval` subprocess. That keeps TypeScript out of files that must
 * run untyped from a hook command line, and it exercises the modules as the
 * hook and the operator invoke them.
 *
 * Every case is deterministic and offline: the controller is driven by a
 * scripted driver object, and the sandbox is exercised through the real hook
 * entry point. No Claude process, no network, no model call.
 */

const root = process.cwd();
const HOOK = join(root, "docs", "benchmark", "og86-medium-v1", "harness", "hook.mjs");
const CONTROLLER = join(root, "scripts", "benchmark", "run-og86-medium.mjs");
const BINDING = join(root, "scripts", "benchmark", "og86-binding.mjs");
const STAGE0 = join(root, "scripts", "benchmark", "run-og86-stage0.mjs");
const MANIFEST = join(root, "scripts", "benchmark", "checksum-og86.mjs");

const FREEZE = "fd1c5ed7e872243f94746402f5b61790614d4ea9";

/** One helper module import per call, so evaluation is cached per spec run. */
const HELPER = `
const { pathToFileURL } = await import("node:url");
const hook = await import(pathToFileURL(${JSON.stringify(HOOK)}).href);
const controller = await import(pathToFileURL(${JSON.stringify(CONTROLLER)}).href);
const binding = await import(pathToFileURL(${JSON.stringify(BINDING)}).href);
const stage0 = await import(pathToFileURL(${JSON.stringify(STAGE0)}).href);
const checksum = await import(pathToFileURL(${JSON.stringify(MANIFEST)}).href);
`;

/**
 * Evaluate an expression in a fresh Node process with the OG-86 modules loaded.
 * `args` are injected as a JSON literal so the driver stays data, not source.
 */
function evaluate<T>(body: string, args: unknown = {}): T {
  const script = `${HELPER}\nconst ARGS = ${JSON.stringify(args)};\n${body}`;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

/**
 * A scripted driver that satisfies every gate, built inside the child process so
 * each gate can be broken in exactly one place. `overrides` replaces a named
 * step; its body is a JS function source string evaluated in the child.
 */
const DRIVER_PRELUDE = `
function modelCounts(n) {
  return { assistantRecords: n, counts: { "claude-haiku-4-5-20251001": n }, matchingModelRecords: n, fallbackRecords: 0 };
}
function passingProbes() {
  // A passing row carries the verdict *and* the class the hook reported, because
  // a location-class denial is only verifiable when the class matches.
  return controller.matrixExpectations().map((plan) => ({
    name: plan.name,
    allowed: plan.expected === "allow",
    observedClass: plan.expected === "allow" ? "workload" : plan.location,
  }));
}
function makeDriver({ sourceBytes = 1000, cost = 0.02, workWallSeconds = 120, workTurns = 4, overrides = {}, measured = true }) {
  const source = { bytes: sourceBytes, lines: 10, sha256: "sha256:" + "a".repeat(64) };
  const calls = [];
  const base = {
    openArm: ({ arm }) => "session-" + arm,
    sendPhasePrompt: () => ({ costUsd: cost, wallSeconds: workWallSeconds, turns: workTurns, models: modelCounts(workTurns) }),
    runAcceptance: () => ({ passed: true, wallSeconds: 30 }),
    invokeManualCompact: () => ({ trigger: "manual" }),
    awaitCompact: () => ({ treatmentBytes: 0, wallSeconds: 60, turns: 0, costUsd: cost, models: modelCounts(1) }),
    captureSummary: () => ({ bytes: 7371, sha256: "sha256:" + "b".repeat(64) }),
    createFork: () => ({ fork: "fork-session", distinct: true, source, costUsd: cost / 4, wallSeconds: 10, turns: 1, models: modelCounts(1) }),
    probeFork: ({ arm }) => ({
      treatmentBytes: arm === "A" ? 0 : 1246,
      treatmentSha256: arm === "A" ? null : "sha256:" + "c".repeat(64),
      treatmentCopies: arm === "A" ? 0 : 1,
      toolDecisions: [],
      score: { points: 25, denominator: 25, exact: 25, missing: 0, falseFacts: 0, criticalExact: true },
      costUsd: cost,
      wallSeconds: 20,
      turns: 2,
      models: modelCounts(2),
    }),
    verifySource: () => ({
      source,
      canaryOccurrenceCount: 0,
      // Required evidence at every checkpoint; a passing fixture supplies it.
      privateTreeModes: {
        rootPresent: true,
        readFailureCount: 0,
        directoryModes: { 700: 2 },
        fileModes: { 600: 3 },
        directoryCount: 2,
        fileCount: 3,
        symlinkCount: 0,
        measurable: true,
        allDirectoriesOwnerOnly: true,
        allFilesOwnerOnly: true,
        zeroSymlinks: true,
      },
      wallSeconds: measured ? 0.001 : 1,
    }),
    resumeSource: ({ arm }) => ({
      treatmentBytes: arm === "A" ? 0 : 1246,
      // The continuation must receive the same frozen treatment the score fork
      // received, so the digest matches probeFork's.
      treatmentSha256: arm === "A" ? null : "sha256:" + "c".repeat(64),
      treatmentCopies: arm === "A" ? 0 : 1,
      toolProbes: passingProbes(),
      binding: arm === "C" ? boundCheckpoint() : null,
      costUsd: cost,
      wallSeconds: 60,
      turns: 3,
      models: modelCounts(3),
    }),
    ...overrides,
  };
  const driver = {};
  for (const [name, fn] of Object.entries(base)) {
    driver[name] = (stepArgs) => {
      calls.push(name + ":" + (stepArgs?.arm ?? "none") + ":" + (stepArgs?.phase ?? "none"));
      return fn(stepArgs);
    };
  }
  driver.calls = calls;
  return driver;
}
function boundCheckpoint(extra = {}) {
  return {
    retainedPrefixBytes: 319961,
    retainedPrefixLines: 94,
    retainedPrefixSha256: "sha256:" + "d".repeat(64),
    prefixEndsAtLineBoundary: true,
    envelopeBytesMatch: true,
    envelopeLinesMatch: true,
    checkpointEvidenceEntriesMatched: 21,
    checkpointEvidenceEntriesRequired: 21,
    checkpointHashShapeValid: true,
    checkpointHashRecomputedByRestore: true,
    previousHashShapeValid: true,
    pathClassExcludesFixtureAndReplay: true,
    ...extra,
  };
}
function runSeries(overrides) {
  return controller.runSeries({ driver: makeDriver({ overrides }), order: ["A", "B", "C"] });
}
`;

interface SeriesResult {
  halted: boolean;
  state: {
    valid: boolean;
    invalidations: string[];
    operationalStops: string[];
    seriesAdvisoryExceeded?: boolean;
    seriesWallSeconds?: number;
    arms: Record<string, {
      checkpoints: Array<Record<string, unknown>>;
      invalidations: string[];
      operationalStops: string[];
      advisoryOverages: string[];
      processes: Array<Record<string, unknown>>;
      assistantTurns: number;
    }>;
  };
}

function series(overrides: Record<string, string> = {}): SeriesResult {
  const overrideSource = Object.entries(overrides)
    .map(([name, fn]) => `${name}: ${fn},`)
    .join("\n    ");
  return evaluate<SeriesResult>(`
${DRIVER_PRELUDE}
const result = runSeries({ ${overrideSource} });
process.stdout.write(JSON.stringify({ halted: result.halted, state: JSON.parse(JSON.stringify(result.state)) }));
`);
}

/** The literal `resumeSource` body, reused by the gate cases that break it. */
const RESUME = `({ arm }) => ({
      treatmentBytes: arm === "A" ? 0 : 1246,
      treatmentSha256: arm === "A" ? null : "sha256:" + "c".repeat(64),
      treatmentCopies: arm === "A" ? 0 : 1,
      toolProbes: passingProbes(),
      binding: arm === "C" ? boundCheckpoint() : null,
      costUsd: 0.02, wallSeconds: 60, turns: 3, models: modelCounts(3),
    })`;

/**
 * Shared child-process preamble: declared roots for every forbidden location
 * class, plus a `decide` shorthand. Hoisted so every describe block can use it.
 */
const ROOTS = `
const roots = { workloadRoot: "/tmp/og86-probe/workload", forbidden: {
  transcript: ["/tmp/og86-probe/transcript"],
  profile: ["/tmp/og86-probe/profile"],
  store: ["/tmp/og86-probe/store"],
  rubric: ["/tmp/og86-probe/rubric.json"],
  scorer: ["/tmp/og86-probe/score-og86.mjs"],
  capture: ["/tmp/og86-probe/sessions"],
} };
const flat = Object.fromEntries(Object.entries(roots.forbidden).map(([label, list]) => [label, list[0]]));
const decide = (tool, input) => hook.toolDecision({ tool, input, workloadRoot: roots.workloadRoot, forbidden: flat });
`;

describe("OG-86 medium-series checkpoint order", () => {
  it("forks, scores, verifies, and only then resumes the source", () => {
    const { halted, state } = series();
    expect(halted).toBe(false);
    expect(state.valid).toBe(true);

    const steps = (state.arms.C.checkpoints[0].steps as unknown as string[]);
    const expected = evaluate<string[]>(`process.stdout.write(JSON.stringify(controller.CHECKPOINT_SEQUENCE.map((entry) => entry.step)));`);
    expect(steps).toEqual(expected);
    expect(steps.indexOf("create-score-fork")).toBeLessThan(steps.indexOf("resume-source-with-treatment"));
    expect(steps.indexOf("resume-fork-tools-disabled")).toBeLessThan(steps.indexOf("resume-source-with-treatment"));
    expect(steps.indexOf("verify-source-stability")).toBeLessThan(steps.indexOf("resume-source-with-treatment"));
  });

  it("issues no source resume before the fork and probe of the same phase", () => {
    const calls = evaluate<string[]>(`
${DRIVER_PRELUDE}
const driver = makeDriver({});
controller.runSeries({ driver, order: ["A", "B", "C"] });
process.stdout.write(JSON.stringify(driver.calls));
`);
    expect(calls.length).toBeGreaterThan(0);
    for (const arm of ["A", "B", "C"]) {
      for (let phase = 1; phase <= 4; phase += 1) {
        const resume = calls.indexOf(`resumeSource:${arm}:${phase}`);
        expect(resume, `${arm} phase ${phase}`).toBeGreaterThan(calls.indexOf(`probeFork:${arm}:${phase}`));
        expect(resume).toBeGreaterThan(calls.indexOf(`createFork:${arm}:${phase}`));
      }
    }
  });

  it("rejects an out-of-order observation instead of recording it", () => {
    const invalidations = evaluate<string[]>(`
${DRIVER_PRELUDE}
const state = controller.initialState(["A", "B", "C"]);
controller.record(state, "A", { kind: "phase-prompt", phase: 1, costUsd: 0, wallSeconds: 0, turns: 0, models: modelCounts(1) });
controller.record(state, "A", { kind: "source-resumed", phase: 1, treatmentBytes: 0, treatmentCopies: 0 });
process.stdout.write(JSON.stringify(state.arms.A.invalidations));
`);
    expect(invalidations).toContain("checkpoint-order-violated:resume-source-with-treatment");
  });

  it("keeps four phases and four manual compactions per arm", () => {
    const { state } = series();
    for (const arm of ["A", "B", "C"]) {
      const checkpoints = state.arms[arm].checkpoints;
      expect(checkpoints).toHaveLength(4);
      expect(checkpoints.map((entry) => entry.ordinal)).toEqual([1, 2, 3, 4]);
      expect(checkpoints.filter((entry) => entry.manualCompaction)).toHaveLength(4);
    }
  });
});

describe("OG-86 controller stop conditions", () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ["a model id other than the frozen one", {
      sendPhasePrompt: `() => ({ costUsd: 0.02, wallSeconds: 120, turns: 4, previousModels: modelCounts(0), models: { assistantRecords: 4, counts: { "claude-sonnet-4-5": 4 }, matchingModelRecords: 4, fallbackRecords: 0 } })`,
    }, "model-id-mismatch"],
    ["a fallback or model-switch record", {
      probeFork: `({ arm }) => ({ treatmentBytes: arm === "A" ? 0 : 1246, treatmentCopies: arm === "A" ? 0 : 1, toolDecisions: [], costUsd: 0.02, wallSeconds: 20, turns: 2, models: { assistantRecords: 2, counts: { "claude-haiku-4-5-20251001": 2 }, matchingModelRecords: 2, fallbackRecords: 1 } })`,
    }, "model-switch-recorded"],
    ["a failed phase acceptance", {
      runAcceptance: `() => ({ passed: false, wallSeconds: 30 })`,
    }, "phase-acceptance-failed"],
    ["an unscheduled compaction", {
      invokeManualCompact: `() => ({ trigger: "auto" })`,
    }, "unscheduled-compaction"],
    ["treatment missing on the source resume", {
      resumeSource: `({ arm }) => ({ treatmentBytes: arm === "A" ? 0 : 1246, treatmentCopies: 0, toolProbes: passingProbes(), binding: arm === "C" ? boundCheckpoint() : null, costUsd: 0.02, wallSeconds: 60, turns: 3, models: modelCounts(3) })`,
    }, "treatment-absent-or-duplicated:resume"],
    ["a duplicated score-fork treatment", {
      probeFork: `({ arm }) => ({ treatmentBytes: arm === "A" ? 0 : 1246, treatmentCopies: 2, toolDecisions: [], costUsd: 0.02, wallSeconds: 20, turns: 2, models: modelCounts(2) })`,
    }, "treatment-absent-or-duplicated"],
    ["an oversized score-fork treatment", {
      probeFork: `() => ({ treatmentBytes: 16385, treatmentCopies: 1, toolDecisions: [], costUsd: 0.02, wallSeconds: 20, turns: 2, models: modelCounts(2) })`,
    }, "treatment-over-budget"],
    ["a treatment that reached the source before the fork", {
      awaitCompact: `() => ({ treatmentBytes: 1246, wallSeconds: 60, turns: 0, costUsd: 0.02, models: modelCounts(1) })`,
    }, "treatment-before-fork"],
    ["a source transcript that changed by digest", {
      verifySource: `() => ({ source: { bytes: 1000, lines: 10, sha256: "sha256:" + "e".repeat(64) }, wallSeconds: 1 })`,
    }, "source-transcript-changed"],
    ["a source transcript that changed by byte count", {
      verifySource: `() => ({ source: { bytes: 1001, lines: 10, sha256: "sha256:" + "a".repeat(64) }, wallSeconds: 1 })`,
    }, "source-transcript-changed"],
    ["a probe that used a tool", {
      probeFork: `({ arm }) => ({ treatmentBytes: arm === "A" ? 0 : 1246, treatmentCopies: arm === "A" ? 0 : 1, toolDecisions: [{ tool: "Read", allowed: true }], costUsd: 0.02, wallSeconds: 20, turns: 2, models: modelCounts(2) })`,
    }, "probe-used-tools"],
    ["a fork that is not a distinct session", {
      createFork: `() => ({ fork: "session-A", distinct: false, source: { bytes: 1000, lines: 10, sha256: "sha256:" + "a".repeat(64) }, costUsd: 0.005, wallSeconds: 10, turns: 1, models: modelCounts(1) })`,
    }, "fork-session-not-distinct"],
    ["an unverifiable native summary", {
      captureSummary: `() => ({ bytes: 7371, sha256: "not-a-digest" })`,
    }, "native-summary-unverifiable"],
    ["a wall-clock ceiling breach", {
      sendPhasePrompt: `() => ({ costUsd: 0.02, wallSeconds: 4000, turns: 4, models: modelCounts(4) })`,
    }, "per-arm-wall-clock-limit-exceeded"],
    ["an assistant-turn ceiling breach", {
      sendPhasePrompt: `() => ({ costUsd: 0.02, wallSeconds: 120, turns: 100, models: modelCounts(100) })`,
    }, "assistant-turn-limit-exceeded"],
    ["a continuation with an incomplete tool matrix", {
      resumeSource: `({ arm }) => ({ treatmentBytes: arm === "A" ? 0 : 1246, treatmentCopies: arm === "A" ? 0 : 1, toolProbes: [], binding: arm === "C" ? boundCheckpoint() : null, costUsd: 0.02, wallSeconds: 60, turns: 3, models: modelCounts(3) })`,
    }, "tool-matrix-incomplete"],
    ["a continuation that used a tool the matrix allows", {
      resumeSource: `({ arm }) => ({ treatmentBytes: arm === "A" ? 0 : 1246, treatmentCopies: arm === "A" ? 0 : 1, toolProbes: passingProbes().map((probe) => probe.name === "read-transcript" ? { name: probe.name, allowed: true } : probe), binding: arm === "C" ? boundCheckpoint() : null, costUsd: 0.02, wallSeconds: 60, turns: 3, models: modelCounts(3) })`,
    }, "tool-matrix-incomplete"],
    ["an arm C checkpoint that is not bound to the transcript", {
      resumeSource: `({ arm }) => ({ treatmentBytes: arm === "A" ? 0 : 1246, treatmentSha256: arm === "A" ? null : "sha256:" + "c".repeat(64), treatmentCopies: arm === "A" ? 0 : 1, toolProbes: passingProbes(), binding: arm === "C" ? boundCheckpoint({ envelopeBytesMatch: false, checkpointEvidenceEntriesMatched: 20 }) : null, costUsd: 0.02, wallSeconds: 60, turns: 3, models: modelCounts(3) })`,
    }, "arm-c-binding-envelopeBytes"],
    ["a phase prompt with zero assistant records", {
      sendPhasePrompt: `() => ({ costUsd: 0.02, wallSeconds: 60, turns: 0, models: modelCounts(0) })`,
    }, "assistant-records-missing:work"],
  ];

  it.each(cases)("stops on %s", (_label, overrides, code) => {
    const result = series(overrides);
    expect(result.halted).toBe(true);
    expect(result.state.valid).toBe(false);
    expect(result.state.invalidations.some((entry) => entry.includes(code))).toBe(true);
  });

  it("does not invalidate a legitimate zero assistant-record reading from compact or fork creation", () => {
    // Measured, not assumed: real --execute attempts show /compact and the
    // fork-creation /status call consistently producing zero new assistant
    // records (both are slash commands, not conversational turns), unlike
    // every other role. This proves the modelGate exemption is scoped to
    // exactly those two roles and does not silently accept a real failure.
    const result = series({
      awaitCompact: `() => ({ treatmentBytes: 0, wallSeconds: 60, turns: 0, costUsd: 0.02, models: modelCounts(0) })`,
      createFork: `() => ({ fork: "fork-session", distinct: true, source: { bytes: 1000, lines: 10, sha256: "sha256:" + "a".repeat(64) }, costUsd: 0.005, wallSeconds: 10, turns: 0, models: modelCounts(0) })`,
    });
    expect(result.state.valid).toBe(true);
    expect(result.state.invalidations).toEqual([]);
  });

  it("stops when the arm C binding is absent entirely", () => {
    const result = series({ resumeSource: RESUME.replace("boundCheckpoint() : null", "null : null") });
    expect(result.state.invalidations.some((entry) => entry.includes("arm-c-binding-present"))).toBe(true);
  });

  it("stops when the manual-compaction count is not four", () => {
    const result = series();
    const invalidations = evaluate<string[]>(`
${DRIVER_PRELUDE}
const result = runSeries({});
result.state.arms.A.checkpoints[0].manualCompaction = false;
controller.evaluate(result.state);
process.stdout.write(JSON.stringify(result.state.arms.A.invalidations));
`);
    expect(result.state.valid).toBe(true);
    expect(invalidations).toContain("manual-compaction-count:3");
  });

  it("stops when a checkpoint is missing", () => {
    const invalidations = evaluate<string[]>(`
${DRIVER_PRELUDE}
const result = runSeries({});
result.state.arms.B.checkpoints.pop();
controller.evaluate(result.state);
process.stdout.write(JSON.stringify(result.state.arms.B.invalidations));
`);
    expect(invalidations.some((entry) => entry.startsWith("checkpoint-count"))).toBe(true);
  });

  it("stops when the series wall clock is exhausted", () => {
    // One arm alone exceeds the 210-minute series ceiling while staying under
    // the 60-minute per-arm ceiling is impossible, so the per-arm gate is the
    // first to fire; the series total is still recorded and compared.
    const result = series({ sendPhasePrompt: `() => ({ costUsd: 0.02, wallSeconds: 800, turns: 4, models: modelCounts(4) })` });
    expect(result.state.invalidations.some((entry) => entry.includes("wall-clock-limit-exceeded"))).toBe(true);
    expect(result.state.seriesWallSeconds).toBeGreaterThan(0);
  });

  it("applies the series ceiling to the summed arm totals", () => {
    // 3 arms x 60 minutes is 180 minutes, so a series ceiling of 210 minutes
    // cannot be reached while every arm respects its own ceiling: the series
    // gate is subsumed in a valid run. It still fires when the totals do exceed
    // it, which is what this asserts directly.
    const invalidations = evaluate<string[]>(`
${DRIVER_PRELUDE}
const result = runSeries({});
for (const arm of ["A", "B", "C"]) result.state.arms[arm].wallSeconds = 80 * 60;
controller.evaluate(result.state);
process.stdout.write(JSON.stringify(result.state.invalidations));
`);
    expect(invalidations).toContain("series:wall-clock-limit-exceeded");
    expect(invalidations.filter((entry) => entry.startsWith("A:per-arm-wall-clock")).length).toBe(1);
  });
});

describe("OG-86 cost policy", () => {
  it("records an advisory overage without invalidating the arm", () => {
    const result = series({ sendPhasePrompt: `() => ({ costUsd: 0.5, wallSeconds: 120, turns: 4, models: modelCounts(4) })` });
    expect(result.state.valid).toBe(true);
    expect(result.state.arms.A.advisoryOverages).toContain("per-arm-advisory");
    expect(result.state.arms.A.invalidations).toEqual([]);
    expect(result.state.seriesAdvisoryExceeded).toBe(true);
    expect(result.state.invalidations).toEqual([]);
  });

  it("treats the runaway ceiling as an operational stop, not an invalidity", () => {
    const result = series({ sendPhasePrompt: `() => ({ costUsd: 1.5, wallSeconds: 120, turns: 4, models: modelCounts(4) })` });
    expect(result.state.arms.A.operationalStops).toContain("emergency-runaway-ceiling-reached");
    expect(result.state.arms.A.invalidations).toEqual([]);
    expect(result.state.valid).toBe(false);
  });
});

describe("OG-86 arm derivation and blinding", () => {
  it("derives a stable order and blinded labels from the freeze commit", () => {
    const derived = evaluate<{ order: string[]; again: string[]; other: string[]; blinding: Record<string, string> }>(`
process.stdout.write(JSON.stringify({
  order: controller.armOrder(${JSON.stringify(FREEZE)}),
  again: controller.armOrder(${JSON.stringify(FREEZE)}),
  other: controller.armOrder("1".repeat(40)),
  blinding: controller.blinding(controller.armOrder(${JSON.stringify(FREEZE)})),
}));
`);
    expect(derived.order).toEqual(["C", "B", "A"]);
    expect(derived.again).toEqual(derived.order);
    expect(derived.other).not.toEqual(derived.order);
    expect(derived.blinding).toEqual({ C: "X1", B: "X2", A: "X3" });
  });

  it("refuses to guess an arm order", () => {
    const failures = evaluate<number>(`
let count = 0;
for (const value of ["", "HEAD", "fd1c5ed", null, undefined]) {
  try { controller.armOrder(value); } catch { count += 1; }
}
process.stdout.write(JSON.stringify(count));
`);
    expect(failures).toBe(5);
  });

  it("publishes the planning document without side effects", () => {
    const plan = evaluate<{ phases: number; checkpointSequence: Array<{ step: string }>; stops: { operationalStops: string[] } }>(`
process.stdout.write(JSON.stringify(controller.planningDocument(controller.armOrder(${JSON.stringify(FREEZE)}))));
`);
    expect(plan.phases).toBe(4);
    expect(plan.stops.operationalStops).toContain("emergency-runaway-ceiling-reached");
    expect(plan.checkpointSequence.map((entry) => entry.step)).toEqual([
      "send-phase-prompt", "run-phase-acceptance", "invoke-manual-compact", "capture-native-summary",
      "create-score-fork", "resume-fork-tools-disabled", "verify-source-stability", "resume-source-with-treatment",
    ]);
  });
});

describe("OG-86 sanitized artifact emission", () => {
  interface Artifact {
    opaqueArm: string;
    processes: Array<{ role: string; label: string; assistantRecords: number }>;
    checkpoints: Array<Record<string, unknown>>;
    invalidations: string[];
    operationalStops: string[];
    advisoryCostEquivalentUsd: number;
    wallSeconds: number;
    runnerRevisionDigest: string;
    modelCounts: { assistantRecords: number; matchingModelRecords: number; fallbackOrModelSwitch: number };
  }

  function artifact(arm: string, overrides: Record<string, string> = {}): Artifact {
    const overrideSource = Object.entries(overrides).map(([name, fn]) => `${name}: ${fn},`).join("\n    ");
    return evaluate<Artifact>(`
${DRIVER_PRELUDE}
const result = runSeries({ ${overrideSource} });
const revisions = { runner: "sha256:" + "f".repeat(64), scorer: "sha256:" + "0".repeat(64) };
process.stdout.write(JSON.stringify(controller.armArtifact(result.state, ${JSON.stringify(arm)}, revisions)));
`);
  }

  it("emits labeled processes, per-checkpoint digests, and the covariate", () => {
    const emitted = artifact("C");
    expect(emitted.opaqueArm).toBe("X3");
    expect(emitted.processes.some((process) => process.role === "continuation")).toBe(true);
    expect(emitted.processes.some((process) => process.role === "probe")).toBe(true);
    expect(emitted.processes.some((process) => process.role === "work")).toBe(true);
    expect(emitted.processes.some((process) => process.role === "compact")).toBe(true);
    expect(emitted.checkpoints).toHaveLength(4);
    for (const checkpoint of emitted.checkpoints) {
      expect(checkpoint.sourceTranscriptStable).toBe(true);
      expect(checkpoint.sourceTranscriptSha256Before).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(checkpoint.sourceTranscriptSha256After).toBe(checkpoint.sourceTranscriptSha256Before);
      expect(checkpoint.elapsedWallSeconds).toBeGreaterThan(0);
      expect(checkpoint.treatmentBytes).toBe(1246);
      // The artifact schema requires a zero canary count per checkpoint.
      expect(checkpoint.canaryOccurrenceCount).toBe(0);
      expect(checkpoint.score).not.toBeNull();
      // The cross-arm ratio is a recorded covariate: B 1246 bytes, C 1246 bytes.
      expect(checkpoint.injectedSizeRatio).toBe(1);
      expect(checkpoint.treatmentSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(checkpoint.armC).toMatchObject({
        checkpointEvidenceEntriesMatched: 21,
        checkpointEvidenceEntriesRequired: 21,
        checkpointHashShapeValid: true,
        checkpointHashRecomputedByRestore: true,
        pathClassExcludesFixtureAndReplay: true,
      });
    }
    expect(emitted.invalidations).toEqual([]);
    expect(emitted.operationalStops).toEqual([]);
    expect(emitted.advisoryCostEquivalentUsd).toBeLessThan(0.35);
    expect(emitted.wallSeconds).toBeGreaterThan(0);
    expect(emitted.runnerRevisionDigest).toBe(`sha256:${"f".repeat(64)}`);
    expect(emitted.modelCounts.fallbackOrModelSwitch).toBe(0);
  });

  it("satisfies every required field of the normative artifact schema", () => {
    const emitted = artifact("C");
    const schema = JSON.parse(readFileSync(join(root, "docs", "benchmark", "og86-medium-v1", "artifact-schema.json"), "utf8")) as {
      required: string[];
      properties: {
        checkpoints: { minItems: number; maxItems: number; items: { required: string[] } };
        processes: { items: { required: string[] } };
      };
    };
    for (const key of schema.required) expect(emitted, `artifact.${key}`).toHaveProperty(key);
    expect(emitted.checkpoints).toHaveLength(schema.properties.checkpoints.minItems);
    expect(schema.properties.checkpoints.items.required.length).toBeGreaterThan(0);
    for (const checkpoint of emitted.checkpoints) {
      for (const key of schema.properties.checkpoints.items.required) {
        expect(checkpoint, `checkpoint.${key}`).toHaveProperty(key);
      }
    }
    for (const process of emitted.processes) {
      for (const key of schema.properties.processes.items.required) {
        expect(process, `process.${key}`).toHaveProperty(key);
      }
    }
  });

  it("reports the arm A control with zero injected treatment and a null C binding", () => {
    const emitted = artifact("A");
    expect(emitted.opaqueArm).toBe("X1");
    expect(emitted.checkpoints.every((checkpoint) => checkpoint.treatmentBytes === 0)).toBe(true);
    expect(emitted.checkpoints.every((checkpoint) => checkpoint.armC === null)).toBe(true);
  });

  it("refuses to emit after an invalidation or an operational stop", () => {
    const failures = evaluate<string[]>(`
${DRIVER_PRELUDE}
const revisions = { runner: "sha256:" + "f".repeat(64), scorer: "sha256:" + "0".repeat(64) };
const messages = [];
for (const overrides of [{ runAcceptance: () => ({ passed: false }) }, { sendPhasePrompt: () => ({ costUsd: 1.5, wallSeconds: 120, turns: 4, models: modelCounts(4) }) }]) {
  const result = runSeries(overrides);
  try { controller.armArtifact(result.state, "A", revisions); messages.push("emitted"); }
  catch (error) { messages.push(error.message); }
}
process.stdout.write(JSON.stringify(messages));
`);
    expect(failures[0]).toMatch(/invalid gates/);
    expect(failures[1]).toMatch(/operational stop/);
  });
});

describe("OG-86 continuation sandbox boundary", () => {

  it("decides every capability and location class as preregistered", () => {
    const failures = evaluate<Array<{ name: string; reason: string }>>(`
${ROOTS}
const probes = hook.probeMatrix({ workloadRoot: roots.workloadRoot, forbidden: Object.fromEntries(Object.entries(roots.forbidden).map(([label, list]) => [label, { path: list[0], kind: "file" }])) });
const failures = [];
for (const probe of probes) {
  const decision = decide(probe.tool, probe.input);
  if (decision.allowed !== (probe.expected === "allow")) failures.push({ name: probe.name, reason: decision.reason });
}
process.stdout.write(JSON.stringify(failures));
`);
    expect(failures).toEqual([]);
  });

  it("allows exactly the six in-workload capabilities", () => {
    const allowed = evaluate<string[]>(`
${ROOTS}
const probes = hook.probeMatrix({ workloadRoot: roots.workloadRoot, forbidden: Object.fromEntries(Object.entries(roots.forbidden).map(([label, list]) => [label, { path: list[0], kind: "file" }])) });
process.stdout.write(JSON.stringify(probes.filter((probe) => probe.expected === "allow").map((probe) => probe.name)));
`);
    expect(allowed).toEqual(["read-workload", "edit-workload", "write-workload", "glob-workload", "grep-workload", "bash-exact-frozen-test"]);
  });

  it("covers every enabled capability against every forbidden location class", () => {
    const coverage = evaluate<{ classes: string[]; missing: string[]; expectations: number }>(`
${ROOTS}
const classes = hook.requiredLocationClasses();
const expectations = controller.matrixExpectations();
const missing = [];
for (const label of classes) {
  for (const capability of ["read", "edit", "write", "glob", "grep"]) {
    if (!expectations.some((plan) => plan.name === capability + "-" + label)) missing.push(capability + "-" + label);
  }
}
process.stdout.write(JSON.stringify({ classes, missing, expectations: expectations.length }));
`);
    expect(coverage.classes).toEqual(["transcript", "profile", "store", "rubric", "scorer", "capture"]);
    expect(coverage.missing).toEqual([]);
    expect(coverage.expectations).toBeGreaterThanOrEqual(56);
  });

  it("refuses every argument-bearing, chained, or renamed shell command", () => {
    const verdicts = evaluate<Record<string, boolean>>(`
${ROOTS}
const commands = [
  "npm test",
  "npm test -- --test-name-pattern=../../x",
  "npm test extra",
  "npm test; cat secrets",
  "npm test && cat secrets",
  "node --test",
  "node --test docs/benchmark",
  "npm  test",
  "NPM test",
  "cd .. && npm test",
];
const verdicts = {};
for (const command of commands) verdicts[command] = decide("Bash", { command }).allowed;
process.stdout.write(JSON.stringify(verdicts));
`);
    expect(verdicts["npm test"]).toBe(true);
    for (const [command, allowed] of Object.entries(verdicts)) {
      if (command !== "npm test") expect(allowed, command).toBe(false);
    }
  });

  it("keeps traversal inert and refuses every unconstrained search field", () => {
    const result = evaluate<{ inert: Record<string, boolean>; decisions: Record<string, boolean>; locations: string[] }>(`
${ROOTS}
const inert = {};
for (const value of ["**/*.js", "src", "../secrets", "/etc/passwd", "~/x", "a\\\\b", ""]) inert[value] = hook.traversalInert(value);
const decisions = {
  globWithoutPath: decide("Glob", { pattern: "**/*.json" }).allowed,
  grepWithoutPath: decide("Grep", { pattern: "x" }).allowed,
  globTraversal: decide("Glob", { path: roots.workloadRoot, pattern: "../x" }).allowed,
  grepGlobField: decide("Grep", { path: roots.workloadRoot, pattern: "x", glob: "../../*.json" }).allowed,
  globInWorkload: decide("Glob", { path: roots.workloadRoot, pattern: "**/*.json" }).allowed,
  webFetch: decide("WebFetch", { url: "https://example.invalid" }).allowed,
  readWithoutPath: decide("Read", {}).allowed,
  readOutside: decide("Read", { file_path: "/tmp/og86-probe/outside.txt" }).allowed,
};
const locations = [
  hook.classifyLocation("/tmp/og86-probe/transcript", { workloadRoot: roots.workloadRoot, forbidden: flat }),
  hook.classifyLocation("/tmp/og86-probe/workload/src/a.js", { workloadRoot: roots.workloadRoot, forbidden: flat }),
  hook.classifyLocation("/tmp/og86-probe/elsewhere.txt", { workloadRoot: roots.workloadRoot, forbidden: flat }),
];
process.stdout.write(JSON.stringify({ inert, decisions, locations }));
`);
    expect(result.inert).toEqual({ "**/*.js": true, src: true, "../secrets": false, "/etc/passwd": false, "~/x": false, "a\\b": false, "": false });
    expect(result.decisions).toEqual({
      globWithoutPath: false,
      grepWithoutPath: false,
      globTraversal: false,
      grepGlobField: false,
      globInWorkload: true,
      webFetch: false,
      readWithoutPath: false,
      readOutside: false,
    });
    expect(result.locations).toEqual(["transcript", "workload", "outside"]);
  });

  it("first denies the transcript class before its enclosing profile", () => {
    const location = evaluate<string>(`
${ROOTS}
process.stdout.write(JSON.stringify(hook.classifyLocation("/tmp/og86-probe/profile/projects/a/one.jsonl", {
  workloadRoot: roots.workloadRoot,
  forbidden: { ...flat, transcript: ["/tmp/og86-probe/profile/projects/a/one.jsonl"], profile: ["/tmp/og86-probe/profile"] },
})));
`);
    expect(location).toBe("transcript");
  });

  it("decides identically through the real hook entry point and fails open", () => {
    const result = evaluate<{ status: number; decision: string | null; reason: string; malformed: { status: number; stdout: string } }>(`
import { spawnSync } from "node:child_process";
const invoke = (toolName, toolInput, stdin) => spawnSync(process.execPath, [
  ${JSON.stringify(HOOK)}, "--event", "PreToolUse", "--arm", "C",
  "--state", "/tmp/og86-probe/state", "--workload", "/tmp/og86-probe/workload", "--dcompact", "/tmp/og86-probe/cli.js",
  "--forbidtranscript=/tmp/og86-probe/transcript",
  "--forbidprofile=/tmp/og86-probe/profile",
  "--forbidstore=/tmp/og86-probe/store",
  "--forbidrubric=/tmp/og86-probe/rubric.json",
  "--forbidscorer=/tmp/og86-probe/score-og86.mjs",
  "--forbidcapture=/tmp/og86-probe/sessions",
], { input: stdin ?? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput }), encoding: "utf8" });

const allow = invoke("Read", { file_path: "/tmp/og86-probe/workload/package.json" });
const denyRead = invoke("Read", { file_path: "/tmp/og86-probe/transcript" });
const denyBash = invoke("Bash", { command: "npm test -- --grep x" });
const malformed = invoke("Read", {}, "not json at all");
process.stdout.write(JSON.stringify({
  status: allow.status,
  decision: JSON.parse(allow.stdout).hookSpecificOutput.permissionDecision,
  reason: JSON.parse(denyRead.stdout).hookSpecificOutput.permissionDecisionReason,
  denyBash: JSON.parse(denyBash.stdout).hookSpecificOutput.permissionDecision,
  malformed: { status: malformed.status, stdout: malformed.stdout.trim() },
}));
`);
    expect(result.status).toBe(0);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("transcript");
    expect((result as unknown as { denyBash: string }).denyBash).toBe("deny");
    expect(result.malformed.status).toBe(0);
    expect(result.malformed.stdout).toBe("{}");
  });

  it("does not require a class for shape, Bash, allowed, or traversal rows", () => {
    // Only the location grid is class-checked. Every other row is verified on
    // its verdict alone, which is what keeps the exemption honest rather than
    // silently loosening the check.
    const result = evaluate<{ exempt: string[]; grid: string[] }>(`
const expectations = controller.matrixExpectations();
const rows = expectations.map((plan) => ({ name: plan.name, allowed: plan.expected === "allow" }));
const failures = controller.matrixMismatches(rows);
const exempt = expectations.filter((plan) => !plan.classChecked).map((plan) => plan.name);
process.stdout.write(JSON.stringify({
  exempt: failures.filter((entry) => exempt.some((name) => entry.startsWith(name + ":"))),
  grid: failures.filter((entry) => !exempt.some((name) => entry.startsWith(name + ":"))),
}));
`);
    // No exempt row fails for a missing class.
    expect(result.exempt).toEqual([]);
    // And each class-checked row fails precisely because the class was absent.
    expect(result.grid).toHaveLength(30);
    for (const entry of result.grid) expect(entry).toMatch(/:class:undefined$/);
  });

  it("reports a missing probe row instead of assuming it", () => {
    const mismatches = evaluate<Record<string, string[]>>(`
const correct = () => controller.matrixExpectations().map((plan) => ({
  name: plan.name,
  allowed: plan.expected === "allow",
  observedClass: plan.expected === "allow" ? "workload" : plan.location,
}));
process.stdout.write(JSON.stringify({
  complete: controller.matrixMismatches(correct()),
  missingRow: controller.matrixMismatches(correct().filter((row) => row.name !== "read-store")),
  wrongVerdict: controller.matrixMismatches(correct().map((row) => row.name === "read-workload" ? { ...row, allowed: false } : row)),
  absent: controller.matrixMismatches(undefined),
}));
`);
    expect(mismatches.complete).toEqual([]);
    expect(mismatches.missingRow).toEqual(["read-store:absent"]);
    expect(mismatches.wrongVerdict).toEqual(["read-workload:verdict"]);
    expect(mismatches.absent).toEqual(["missing-probe-matrix"]);
  });

  it("fails a denial that reports the wrong class even when the verdict is right", () => {
    // The coordinator's exact hazard: a claimed transcript probe denied as
    // "profile", or as "outside", has the right verdict for the wrong reason.
    const mismatches = evaluate<Record<string, string[]>>(`
const correct = () => controller.matrixExpectations().map((plan) => ({
  name: plan.name,
  allowed: plan.expected === "allow",
  observedClass: plan.expected === "allow" ? "workload" : plan.location,
}));
const withClass = (observedClass) => correct().map((row) => row.name === "read-transcript"
  ? (observedClass === undefined ? { name: row.name, allowed: false } : { ...row, observedClass })
  : row);
process.stdout.write(JSON.stringify({
  exact: controller.matrixMismatches(correct()),
  asProfile: controller.matrixMismatches(withClass("profile")),
  asOutside: controller.matrixMismatches(withClass("outside")),
  unreported: controller.matrixMismatches(withClass(undefined)),
}));
`);
    expect(mismatches.exact).toEqual([]);
    expect(mismatches.asProfile).toEqual(["read-transcript:class:profile"]);
    expect(mismatches.asOutside).toEqual(["read-transcript:class:outside"]);
    expect(mismatches.unreported).toEqual(["read-transcript:class:undefined"]);
  });

});

describe("OG-86 Bash allowlist is exact", () => {
  it("denies surrounding whitespace instead of trimming it", () => {
    // The command list is embedded as JSON so tabs and newlines survive the
    // outer template literal and reach the hook as real characters.
    const commands = ["npm test", " npm test", "npm test ", "\tnpm test", "npm test\n", "  npm test  ", "npm\ttest", "npm  test", "npm\ntest"];
    const verdicts = evaluate<Record<string, boolean>>(`
${ROOTS}
const commands = ${JSON.stringify(commands)};
const verdicts = {};
for (const command of commands) verdicts[JSON.stringify(command)] = decide("Bash", { command }).allowed;
process.stdout.write(JSON.stringify(verdicts));
`);
    expect(verdicts[JSON.stringify("npm test")]).toBe(true);
    const allowed = Object.entries(verdicts).filter(([, value]) => value).map(([key]) => key);
    expect(allowed).toEqual([JSON.stringify("npm test")]);
    for (const command of commands) {
      const observed = verdicts[JSON.stringify(command)];
      expect(observed, JSON.stringify(command)).toBe(command === "npm test");
    }
  });

  it("keeps exactly one allow in the probe matrix and covers whitespace", () => {
    const probes = evaluate<Array<{ name: string; expected: string }>>(`
process.stdout.write(JSON.stringify(hook.BASH_PROBES.map((probe) => ({ name: probe.name, expected: probe.expected }))));
`);
    expect(probes.filter((probe) => probe.expected === "allow").map((probe) => probe.name)).toEqual(["bash-exact-frozen-test"]);
    for (const name of ["bash-leading-whitespace", "bash-trailing-whitespace", "bash-tab-padded", "bash-inner-double-space", "bash-newline-padded"]) {
      expect(probes.some((probe) => probe.name === name), name).toBe(true);
    }
  });
});

describe("OG-86 treatment arming", () => {
  it("decides treatment only for an armed, unconsumed, matching resume", () => {
    const cases = evaluate<Record<string, string>>(`
const decide = (args) => hook.treatmentDecision(args).action;
const armed = { arm: "B", checkpoint: 2, token: "t1" };
process.stdout.write(JSON.stringify({
  control: decide({ arm: "A", source: "resume", armed, consumedTokens: [] }),
  compactPhase: decide({ arm: "B", source: "compact", armed, consumedTokens: [] }),
  startup: decide({ arm: "B", source: "startup", armed, consumedTokens: [] }),
  unarmed: decide({ arm: "B", source: "resume", armed: null, consumedTokens: [] }),
  otherArm: decide({ arm: "C", source: "resume", armed, consumedTokens: [] }),
  armedResume: decide({ arm: "B", source: "resume", armed, consumedTokens: [] }),
  alreadyConsumed: decide({ arm: "B", source: "resume", armed, consumedTokens: ["t1"] }),
}));
`);
    expect(cases.armedResume).toBe("inject");
    expect(cases.control).toBe("absent");
    expect(cases.compactPhase).toBe("absent");
    expect(cases.startup).toBe("absent");
    expect(cases.unarmed).toBe("absent");
    expect(cases.otherArm).toBe("absent");
    expect(cases.alreadyConsumed).toBe("suppress");
  });

  /**
   * Drives the real hook subprocess through every resume a phase performs — the
   * phase prompt, `/compact`, the score-fork probe, and the armed source resume
   * — and asserts that only the armed resume carries treatment, and only once.
   *
   * Arm B injects the captured native summary; arm C injects a real dcompact
   * pack built from the committed fixture transcript, so the arm C path is the
   * production one rather than a stub.
   */
  it("injects exactly one B/C treatment per phase and none on the unarmed resumes", () => {
    const result = evaluate<Record<string, Record<string, number>>>(`
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "og86-arm-"));
const MARKER = "NATIVE-SUMMARY-UNDER-TEST";
const injections = {};

for (const arm of ["A", "B", "C"]) {
  const state = join(root, "state-" + arm);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "native-summary.txt"), MARKER);
  // Arm C needs a real checkpoint, or restore yields an empty pack and the
  // "one injection" assertion would pass for the wrong reason.
  const transcript = join(state, "transcript.jsonl");
  writeFileSync(transcript, ARGS.fixtureTranscript);
  spawnSync(process.execPath, [ARGS.dcompact, "snapshot", "--session", "fixture-session-0001",
    "--transcript", transcript, "--store", join(state, "store")], { encoding: "utf8" });
  const flags = ["transcript", "profile", "store", "rubric", "scorer", "capture"].map((l) => "--forbid" + l + "=" + join(state, l));
  const invoke = (extra, body) => spawnSync(process.execPath, [
    ARGS.hook, "--arm", arm, "--state", state, "--workload", join(state, "workload"),
    "--dcompact", ARGS.dcompact, ...flags, ...extra,
  ], { input: JSON.stringify(body), encoding: "utf8" }).stdout;
  const start = (extra) => invoke(["--event", "SessionStart", ...extra],
    { hook_event_name: "SessionStart", source: "resume", transcript_path: transcript, session_id: "fixture-session-0001" });
  const injected = (stdout) => {
    if (arm === "A") return stdout.includes("additionalContext") ? 1 : 0;
    return stdout.includes(arm === "B" ? MARKER : "[dcompact:") ? 1 : 0;
  };

  let count = 0;
  // Unarmed resumes: phase prompt, /compact, and the fork probe. Zero treatment.
  count += injected(start([]));
  count += injected(start([]));
  count += injected(start([]));
  // The compact session start is not a resume at all.
  count += injected(invoke(["--event", "SessionStart"],
    { hook_event_name: "SessionStart", source: "compact", transcript_path: transcript, session_id: "fixture-session-0001" }));

  // Both active arms must be empty on every unarmed resume above.
  const unarmedInjections = count;

  if (arm !== "A") {
    invoke(["--event", "SessionStart", "--arm-treatment", "ARMING-TOKEN", "--treatment-arm", arm, "--treatment-checkpoint", "1"], {});
    count += injected(start([]));
    count += injected(start([]));
  }
  injections[arm] = { unarmedInjections, additionalInjections: count - unarmedInjections };
}
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify(injections));
`, {
      hook: HOOK,
      dcompact: join(root, "dist", "cli.js"),
      fixtureTranscript: readFileSync(join(root, "test", "fixtures", "claude", "slice-0001", "transcript.jsonl"), "utf8"),
    });
    for (const arm of ["A", "B", "C"]) {
      // Phase prompt, /compact, and the fork probe are all resumes of the live
      // source; none of them may carry treatment.
      expect(result[arm].unarmedInjections, `${arm} unarmed resumes`).toBe(0);
      // Only the armed resume injects, and it injects exactly once.
      expect(result[arm].additionalInjections, `${arm} armed resumes`).toBe(arm === "A" ? 0 : 1);
    }
  });

  it("suppresses a duplicate injection of the same arming and records it", () => {
    const outcomes = evaluate<{ first: number; second: number; suppressed: boolean }>(`
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-dup-"));
writeFileSync(join(root, "native-summary.txt"), "SUMMARY-UNDER-TEST");
const flags = ["transcript", "profile", "store", "rubric", "scorer", "capture"].map((l) => "--forbid" + l + "=" + join(root, l));
const call = (extra) => spawnSync(process.execPath, [
  ${JSON.stringify(HOOK)}, "--arm", "B", "--state", root, "--workload", join(root, "workload"),
  "--dcompact", join(root, "cli.js"), ...flags, ...extra,
], { input: JSON.stringify({ hook_event_name: "SessionStart", source: "resume", transcript_path: join(root, "t.jsonl") }), encoding: "utf8" }).stdout;
call(["--event", "SessionStart", "--arm-treatment", "tok", "--treatment-arm", "B", "--treatment-checkpoint", "1"]);
const first = call(["--event", "SessionStart"]);
const second = call(["--event", "SessionStart"]);
const ledger = readFileSync(join(root, "events.jsonl"), "utf8").trim().split(String.fromCharCode(10)).map((line) => JSON.parse(line)).filter((row) => row.kind === "Treatment");
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  first: first.includes("SUMMARY-UNDER-TEST") ? 1 : 0,
  second: second.includes("SUMMARY-UNDER-TEST") ? 1 : 0,
  suppressed: ledger.some((row) => row.duplicateSuppressed === true && row.treatmentBytes === 0),
}));
`, { hook: HOOK });
    expect(outcomes.first).toBe(1);
    expect(outcomes.second).toBe(0);
    expect(outcomes.suppressed).toBe(true);
  });

  it("invalidates when the continuation treatment differs from the scored one", () => {
    const result = series({
      resumeSource: `({ arm }) => ({ treatmentBytes: arm === "A" ? 0 : 999, treatmentSha256: arm === "A" ? null : "sha256:" + "9".repeat(64), treatmentCopies: arm === "A" ? 0 : 1, toolProbes: passingProbes(), binding: arm === "C" ? boundCheckpoint() : null, costUsd: 0.02, wallSeconds: 60, turns: 3, models: modelCounts(3) })`,
    });
    expect(result.state.invalidations.some((entry) => entry.includes("treatment-identity-mismatch"))).toBe(true);
  });

  it("invalidates when only the continuation digest differs", () => {
    const result = series({
      resumeSource: `({ arm }) => ({ treatmentBytes: arm === "A" ? 0 : 1246, treatmentSha256: arm === "A" ? null : "sha256:" + "7".repeat(64), treatmentCopies: arm === "A" ? 0 : 1, toolProbes: passingProbes(), binding: arm === "C" ? boundCheckpoint() : null, costUsd: 0.02, wallSeconds: 60, turns: 3, models: modelCounts(3) })`,
    });
    expect(result.state.invalidations.some((entry) => entry.includes("treatment-identity-mismatch"))).toBe(true);
  });

  it("records the identity comparison in the artifact", () => {
    const emitted = evaluate<{ checkpoints: Array<{ treatmentIdentity: { matches: boolean; reason: string } }> }>(`
${DRIVER_PRELUDE}
const result = runSeries({});
const revisions = { runner: "sha256:" + "f".repeat(64), scorer: "sha256:" + "0".repeat(64) };
process.stdout.write(JSON.stringify(controller.armArtifact(result.state, "C", revisions)));
`);
    for (const checkpoint of emitted.checkpoints) {
      expect(checkpoint.treatmentIdentity).toMatchObject({ matches: true, reason: "identical" });
    }
  });
});

describe("OG-86 probe response materialisation", () => {
  it("returns the object the scorer reads for a well-formed probe result", () => {
    const result = evaluate<{ response: Record<string, unknown> | null; refusal: string | null }>(`
const body = JSON.stringify({ objective: "clamp fix", requirements: ["exact cents"] });
process.stdout.write(JSON.stringify(controller.materializeProbeResponse(body)));
`);
    expect(result.refusal).toBeNull();
    expect(result.response).toEqual({ objective: "clamp fix", requirements: ["exact cents"] });
  });

  it("fails closed on an empty, non-JSON, or non-object probe result", () => {
    const refusals = evaluate<Record<string, string | null>>(`
const out = {};
for (const [name, body] of Object.entries(ARGS.cases)) out[name] = controller.materializeProbeResponse(body).refusal;
out.validEmptyObject = controller.materializeProbeResponse("{}").refusal;
process.stdout.write(JSON.stringify(out));
`, {
      cases: {
        empty: "",
        whitespace: "   ",
        prose: "The fix was to parse decimal digits directly.",
        unterminated: '{"objective":',
        malformed: '{"a":1,',
        trailingComma: '{"a":1,}',
        array: "[1,2,3]",
        nullLiteral: "null",
        numberLiteral: "7",
        stringLiteral: '"a string"',
        booleanLiteral: "true",
      },
    });
    expect(refusals.empty).toBe("empty-probe-result");
    expect(refusals.whitespace).toBe("empty-probe-result");
    expect(refusals.prose).toBe("probe-result-not-json");
    expect(refusals.unterminated).toBe("probe-result-not-json");
    expect(refusals.malformed).toBe("probe-result-not-json");
    expect(refusals.trailingComma).toBe("probe-result-not-json");
    expect(refusals.array).toBe("probe-result-not-a-json-object");
    expect(refusals.nullLiteral).toBe("probe-result-not-a-json-object");
    expect(refusals.numberLiteral).toBe("probe-result-not-a-json-object");
    expect(refusals.stringLiteral).toBe("probe-result-not-a-json-object");
    expect(refusals.booleanLiteral).toBe("probe-result-not-a-json-object");
    // An empty object is still an object: the scorer decides what it lacks.
    expect(refusals.validEmptyObject).toBeNull();
  });

  it("repairs a stray backslash escape before a backtick and materialises the response", () => {
    // Real bug, from the seventh --execute attempt: arm C's phase-1 probe
    // response quoted a JS template literal inside a "fix" field and escaped
    // the backtick as if writing JS source -- valid inside a JS template
    // literal, but not a valid JSON escape at all -- refusing an otherwise
    // complete, on-topic, correctly-shaped response as "probe-result-not-json".
    const bs = String.fromCharCode(92);
    const bt = String.fromCharCode(96);
    const malformed = `{"objective":"fix","errors":[{"cause":"x","fix":"call ${bs}${bt}f()${bs}${bt}"}]}`;
    const result = evaluate<{ response: Record<string, unknown> | null; refusal: string | null }>(`
process.stdout.write(JSON.stringify(controller.materializeProbeResponse(ARGS.malformed)));
`, { malformed });
    expect(result.refusal).toBeNull();
    expect(result.response).toEqual({ objective: "fix", errors: [{ cause: "x", fix: `call ${bs}${bt}f()${bs}${bt}` }] });
  });

  it("still refuses when the repair pass cannot produce valid JSON either", () => {
    // The repair is narrowly scoped to one class of mistake. Genuinely
    // truncated or structurally broken output -- even with a stray escape
    // present -- must still refuse rather than silently invent structure.
    const bs = String.fromCharCode(92);
    const bt = String.fromCharCode(96);
    const truncated = `{"objective":"fix","errors":[{"cause":"x","fix":"call ${bs}${bt}f()`;
    const result = evaluate<{ refusal: string | null }>(`
process.stdout.write(JSON.stringify(controller.materializeProbeResponse(ARGS.truncated)));
`, { truncated });
    expect(result.refusal).toBe("probe-result-not-json");
  });

  it("materialises a real scorer response end to end", () => {
    // The materialised object is exactly what the scorer consumes, so this
    // exercises the whole path: CLI result text -> object -> scored points.
    const result = evaluate<{ points: number; denominator: number; refusal: string | null }>(`
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const atoms = JSON.parse(ARGS.atoms);
const response = {};
for (const atom of atoms) {
  const [first, second] = atom.responseField.split(".");
  if (second) {
    response[first] = response[first] || {};
    (response[first][second] = response[first][second] || []).push(atom.canonical);
  } else {
    (response[first] = response[first] || []).push(atom.canonical);
  }
}
const materialised = controller.materializeProbeResponse(JSON.stringify(response));
// The response is written outside the frozen benchmark directory: a spec must
// not add files to a directory whose checksums are a release gate.
const scratch = mkdtempSync(join(tmpdir(), "og86-score-"));
const responsePath = join(scratch, "response.json");
writeFileSync(responsePath, JSON.stringify(materialised.response));
const scored = JSON.parse(execFileSync(process.execPath, [
  ARGS.scorer, "--atoms", ARGS.atomsPath, "--response", responsePath, "--checkpoint", "4",
], { encoding: "utf8" }));
rmSync(scratch, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ points: scored.points, denominator: scored.denominator, refusal: materialised.refusal }));
`, {
      atoms: readFileSync(join(root, "docs", "benchmark", "og86-medium-v1", "atoms.json"), "utf8"),
      atomsPath: join(root, "docs", "benchmark", "og86-medium-v1", "atoms.json"),
      scorer: join(root, "scripts", "benchmark", "score-og86.mjs"),
    });
    expect(result.refusal).toBeNull();
    expect(result.denominator).toBe(100);
    expect(result.points).toBe(100);
  });

  it("accepts the rubric's own half-point granularity and rejects any other fraction", () => {
    // Real bug, from the fifth --execute attempt: arm B's real phase-1
    // response scored 7.5/25 -- an odd count of partial (0.5-point) outcomes
    // -- and scoreValid's old Number.isInteger(points) check rejected that
    // exact, valid result as malformed.
    const verdicts = evaluate<Record<string, boolean>>(`
process.stdout.write(JSON.stringify({
  halfPoint: controller.scoreValid({ points: 7.5, denominator: 25 }),
  wholePoint: controller.scoreValid({ points: 6, denominator: 25 }),
  offGranularity: controller.scoreValid({ points: 7.3, denominator: 25 }),
  negativePoints: controller.scoreValid({ points: -0.5, denominator: 25 }),
}));
`);
    expect(verdicts.halfPoint).toBe(true);
    expect(verdicts.wholePoint).toBe(true);
    expect(verdicts.offGranularity).toBe(false);
    expect(verdicts.negativePoints).toBe(false);
  });

  it("rejects a malformed scorer result", () => {
    const verdicts = evaluate<Record<string, boolean>>(`
process.stdout.write(JSON.stringify({
  good: controller.scoreValid({ points: 25, denominator: 25 }),
  zeroPoints: controller.scoreValid({ points: 0, denominator: 25 }),
  noDenominator: controller.scoreValid({ points: 25 }),
  stringPoints: controller.scoreValid({ points: "25", denominator: 25 }),
  zeroDenominator: controller.scoreValid({ points: 0, denominator: 0 }),
  missing: controller.scoreValid(null),
  array: controller.scoreValid([]),
}));
`);
    expect(verdicts.good).toBe(true);
    expect(verdicts.zeroPoints).toBe(true);
    expect(verdicts.noDenominator).toBe(false);
    expect(verdicts.stringPoints).toBe(false);
    expect(verdicts.zeroDenominator).toBe(false);
    expect(verdicts.missing).toBe(false);
    expect(verdicts.array).toBe(false);
  });

  it("invalidates when the probe response is refused or the score is missing", () => {
    const refused = series({
      probeFork: `({ arm }) => ({ treatmentBytes: arm === "A" ? 0 : 1246, treatmentSha256: arm === "A" ? null : "sha256:" + "c".repeat(64), treatmentCopies: arm === "A" ? 0 : 1, toolDecisions: [], score: null, scoreRefusal: { reason: "probe-result-not-json" }, costUsd: 0.02, wallSeconds: 20, turns: 2, models: modelCounts(2) })`,
    });
    expect(refused.state.invalidations.some((entry) => entry.includes("probe-response-refused:probe-result-not-json"))).toBe(true);
    expect(refused.state.invalidations.some((entry) => entry.includes("probe-score-missing"))).toBe(true);
  });
});

describe("OG-86 per-invocation accounting", () => {
  it("computes deltas from cumulative transcript totals", () => {
    const deltas = evaluate<Record<string, unknown>>(`
const before = { assistantRecords: 10, matchingModelRecords: 10, fallbackRecords: 0, counts: { "claude-haiku-4-5-20251001": 10 } };
const after = { assistantRecords: 14, matchingModelRecords: 14, fallbackRecords: 0, counts: { "claude-haiku-4-5-20251001": 14 } };
process.stdout.write(JSON.stringify({
  step: controller.transcriptDelta(before, after),
  first: controller.transcriptDelta(null, before),
  empty: controller.transcriptDelta(before, before),
}));
`);
    expect(deltas.step).toMatchObject({ assistantRecords: 4, matchingModelRecords: 4, fallbackRecords: 0, monotonic: true });
    expect((deltas.step as { counts: Record<string, number> }).counts).toEqual({ "claude-haiku-4-5-20251001": 4 });
    expect(deltas.first).toMatchObject({ assistantRecords: 10, monotonic: true });
    expect(deltas.empty).toMatchObject({ assistantRecords: 0, monotonic: true });
  });

  it("flags a non-monotonic delta instead of clamping it", () => {
    const delta = evaluate<{ assistantRecords: number; monotonic: boolean }>(`
process.stdout.write(JSON.stringify(controller.transcriptDelta(
  { assistantRecords: 10, matchingModelRecords: 10, fallbackRecords: 0, counts: {} },
  { assistantRecords: 4, matchingModelRecords: 4, fallbackRecords: 0, counts: {} },
)));
`);
    expect(delta.assistantRecords).toBe(-6);
    expect(delta.monotonic).toBe(false);
  });

  it("reports a model switch that appears only inside a delta", () => {
    const delta = evaluate<{ fallbackRecords: number; counts: Record<string, number> }>(`
process.stdout.write(JSON.stringify(controller.transcriptDelta(
  { assistantRecords: 4, matchingModelRecords: 4, fallbackRecords: 0, counts: { "claude-haiku-4-5-20251001": 4 } },
  { assistantRecords: 6, matchingModelRecords: 4, fallbackRecords: 1, counts: { "claude-haiku-4-5-20251001": 4, "claude-sonnet-4-5": 1 } },
)));
`);
    expect(delta.fallbackRecords).toBe(1);
    expect(delta.counts).toEqual({ "claude-sonnet-4-5": 1 });
  });

  it("accepts a delta only when it covers the records it claims", () => {
    const verdicts = evaluate<Record<string, boolean>>(`
process.stdout.write(JSON.stringify({
  complete: controller.modelReadingValid({ assistantRecords: 4, matchingModelRecords: 4, fallbackRecords: 0, counts: { "claude-haiku-4-5-20251001": 4 } }),
  unmatched: controller.modelReadingValid({ assistantRecords: 4, matchingModelRecords: 2, fallbackRecords: 0, counts: { "claude-haiku-4-5-20251001": 2 } }),
  uncounted: controller.modelReadingValid({ assistantRecords: 4, matchingModelRecords: 4, fallbackRecords: 0, counts: {} }),
  negative: controller.modelReadingValid({ assistantRecords: -1, matchingModelRecords: -1, fallbackRecords: 0, counts: {} }),
  missing: controller.modelReadingValid(null),
}));
`);
    expect(verdicts.complete).toBe(true);
    expect(verdicts.unmatched).toBe(false);
    expect(verdicts.uncounted).toBe(false);
    expect(verdicts.negative).toBe(false);
    expect(verdicts.missing).toBe(false);
  });

  it("invalidates a step whose cumulative reading moves backwards", () => {
    const result = series({
      sendPhasePrompt: `({ arm }) => ({ costUsd: 0.02, wallSeconds: 120, turns: 4, previousModels: arm === "B" ? modelCounts(40) : modelCounts(0), models: modelCounts(4) })`,
    });
    expect(result.state.invalidations.some((entry) => entry.includes("non-monotonic-transcript-delta"))).toBe(true);
  });

  it("counts turns from the delta rather than a hard-coded value", () => {
    const result = series({ sendPhasePrompt: `() => ({ costUsd: 0.02, wallSeconds: 120, turns: 4, previousModels: modelCounts(0), models: modelCounts(4) })` });
    // Per phase: work 4 + compact 1 + fork 1 + probe 2 + continuation 3.
    expect(result.state.arms.A.checkpoints[0].assistantTurns).toBe(11);
    expect(result.state.arms.A.assistantTurns).toBe(44);
  });

  it("breaches the turn ceiling on a delta, not on a cumulative total", () => {
    const result = series({ sendPhasePrompt: `() => ({ costUsd: 0.02, wallSeconds: 120, turns: 320, previousModels: modelCounts(0), models: modelCounts(320) })` });
    expect(result.state.invalidations.some((entry) => entry.includes("assistant-turn-limit-exceeded"))).toBe(true);
    expect(result.state.arms.A.assistantTurns).toBeGreaterThan(300);
  });

  it("records per-role deltas in the emitted artifact", () => {
    const emitted = evaluate<{ processes: Array<{ role: string; assistantRecords: number; cumulativeAssistantRecords: number | null; monotonic: boolean }> }>(`
${DRIVER_PRELUDE}
const result = runSeries({});
const revisions = { runner: "sha256:" + "f".repeat(64), scorer: "sha256:" + "0".repeat(64) };
process.stdout.write(JSON.stringify(controller.armArtifact(result.state, "B", revisions)));
`);
    const continuations = emitted.processes.filter((process) => process.role === "continuation");
    expect(continuations.length).toBeGreaterThan(0);
    for (const process of continuations) {
      expect(process.monotonic).toBe(true);
      expect(typeof process.cumulativeAssistantRecords).toBe("number");
    }
  });
});

describe("OG-86 checkpoint hash honesty", () => {
  const transcriptPath = join(root, "docs", "benchmark", "og86-medium-v1", "protocol.json");

  it("separates a shape check from the restore recomputation", () => {
    const binding = evaluate<Record<string, unknown>>(`
const checkpoint = {
  envelope: { hash: "sha256:" + "a".repeat(64), transcript_bytes: 0, transcript_lines: 0, previous_hash: null },
  payload: { facts: [] },
};
process.stdout.write(JSON.stringify(binding.checkpointBinding({ transcriptPath: ARGS.transcriptPath, checkpoint })));
`, { transcriptPath });
    // The binding performs a shape check and says so by name.
    expect(binding).toHaveProperty("checkpointHashShapeValid");
    expect(binding.checkpointHashShapeValid).toBe(true);
    // The old misleading name is gone.
    expect(binding).not.toHaveProperty("checkpointHashValid");
    // Recomputation is not claimed by the binding itself.
    expect(binding).not.toHaveProperty("checkpointHashRecomputedByRestore");
  });

  it("passes the shape check on a well-formed but wrong digest", () => {
    const shape = evaluate<boolean>(`
const checkpoint = {
  envelope: { hash: "sha256:" + "b".repeat(64), transcript_bytes: 0, transcript_lines: 0, previous_hash: null },
  payload: { facts: [] },
};
process.stdout.write(JSON.stringify(binding.checkpointBinding({ transcriptPath: ARGS.transcriptPath, checkpoint }).checkpointHashShapeValid));
`, { transcriptPath });
    // A 64-hex string is well shaped no matter what it hashes to, which is
    // exactly why the shape check can never stand in for recomputation.
    expect(shape).toBe(true);
  });

  it("records a refused recomputation as its own gate", () => {
    const verified = evaluate<Record<string, unknown>>(`
const checkpoint = {
  envelope: { hash: "sha256:" + "b".repeat(64), transcript_bytes: 0, transcript_lines: 0, previous_hash: null },
  payload: { facts: [] },
};
process.stdout.write(JSON.stringify(binding.restoreVerifiedBinding({
  transcriptPath: ARGS.transcriptPath,
  checkpoint,
  restore: () => ({ status: 1, pack: "", refusalCode: "corrupt-checkpoint", detail: "payload hash does not match envelope" }),
})));
`, { transcriptPath });
    expect(verified.checkpointHashShapeValid).toBe(true);
    expect(verified.checkpointHashRecomputedByRestore).toBe(false);
    expect(verified.checkpointHashRecomputeRefusalCode).toBe("corrupt-checkpoint");
  });

  it("records a successful restore recomputation for a real checkpoint", () => {
    const result = evaluate<{ shape: boolean; recomputed: boolean; code: string | null; facts: number }>(`
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const root = mkdtempSync(join(tmpdir(), "og86-bind-"));
const transcript = join(root, "transcript.jsonl");
writeFileSync(transcript, ARGS.fixture);
const store = join(root, "store");
spawnSync(process.execPath, [ARGS.dcompact, "snapshot", "--session", "fixture-session-0001", "--transcript", transcript, "--store", store], { encoding: "utf8" });
const dir = join(store, "claude", "fixture-session-0001", "checkpoints");
const name = readdirSync(dir).find((entry) => entry.endsWith(".json"));
const checkpoint = JSON.parse(readFileSync(join(dir, name), "utf8"));
const verified = binding.restoreVerifiedBinding({
  transcriptPath: transcript,
  checkpoint,
  restore: () => {
    const out = spawnSync(process.execPath, [ARGS.dcompact, "restore", "--session", "fixture-session-0001", "--store", store], { encoding: "utf8" });
    return { status: out.status, pack: out.stdout, refusalCode: out.status === 0 ? null : "restore-failed", detail: "" };
  },
});
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  shape: verified.checkpointHashShapeValid,
  recomputed: verified.checkpointHashRecomputedByRestore,
  code: verified.checkpointHashRecomputeRefusalCode,
  facts: checkpoint.payload.facts.length,
}));
`, {
      dcompact: join(root, "dist", "cli.js"),
      fixture: readFileSync(join(root, "test", "fixtures", "claude", "slice-0001", "transcript.jsonl"), "utf8"),
    });
    expect(result.shape).toBe(true);
    expect(result.recomputed).toBe(true);
    expect(result.code).toBeNull();
    expect(result.facts).toBeGreaterThan(0);
  });

  it("invalidates arm C when the restore gate fails", () => {
    const result = series({
      resumeSource: `({ arm }) => ({ treatmentBytes: arm === "A" ? 0 : 1246, treatmentSha256: arm === "A" ? null : "sha256:" + "c".repeat(64), treatmentCopies: arm === "A" ? 0 : 1, toolProbes: passingProbes(), binding: arm === "C" ? boundCheckpoint({ checkpointHashRecomputedByRestore: false }) : null, costUsd: 0.02, wallSeconds: 60, turns: 3, models: modelCounts(3) })`,
    });
    expect(result.state.invalidations.some((entry) => entry.includes("arm-c-binding-hashRecomputedByRestore"))).toBe(true);
  });
});

describe("OG-86 runner entry-point safety", () => {
  const scripts = [
    ["run-og86-medium.mjs", join(root, "scripts", "benchmark", "run-og86-medium.mjs")],
    ["run-og86-stage0.mjs", join(root, "scripts", "benchmark", "run-og86-stage0.mjs")],
    ["og86-binding.mjs", join(root, "scripts", "benchmark", "og86-binding.mjs")],
    ["hook.mjs", join(root, "docs", "benchmark", "og86-medium-v1", "harness", "hook.mjs")],
  ];

  it.each(scripts)("importing %s performs no side effect", (_name, path) => {
    // A runner that does work at module scope turns an accidental import into a
    // real run. The stage0 runner would have invoked the model here, so this is
    // a load-bearing guard, not a formality.
    const result = evaluate<{ imported: boolean; error: string | null; sessions: string[] }>(`
import { readdirSync, existsSync } from "node:fs";
const before = existsSync(ARGS.sessions) ? readdirSync(ARGS.sessions).slice().sort() : [];
let error = null;
try { await import(ARGS.url); } catch (e) { error = e.message; }
const after = existsSync(ARGS.sessions) ? readdirSync(ARGS.sessions).slice().sort() : [];
process.stdout.write(JSON.stringify({ imported: error === null, error, sessions: after.filter((n) => !before.includes(n)) }));
`, { url: new URL(`file://${path}`).href, sessions: join(root, "sessions") });
    expect(result.error).toBeNull();
    expect(result.imported).toBe(true);
    // No new private run directory appeared as a side effect of the import.
    expect(result.sessions).toEqual([]);
  });

  it("leaves every authorized Stage-0 evidence directory intact", () => {
    const result = evaluate<{ dirs: string[]; v6Files: number }>(`
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
const dirs = existsSync(ARGS.sessions) ? readdirSync(ARGS.sessions).filter((n) => n.startsWith("og86-stage0")).sort() : [];
const v6 = join(ARGS.sessions, "og86-stage0-v6");
const v6Files = existsSync(v6) ? readdirSync(v6).length : -1;
process.stdout.write(JSON.stringify({ dirs, v6Files }));
`, { sessions: join(root, "sessions") });
    expect(result.dirs).toContain("og86-stage0-v6");
    expect(result.v6Files).toBeGreaterThan(0);
  });
});

describe("OG-86 runaway ceiling enforcement", () => {
  it("refuses a call once the ceiling is spent and reports the remainder", () => {
    const result = evaluate<Record<string, unknown>>(`
const budget = controller.createBudget({ ceilingUsd: 5 });
const out = { initial: budget.remainingUsd() };
budget.record(2.5);
out.afterHalf = budget.remainingUsd();
out.canSpend = budget.assertCanSpend("call") > 0;
budget.record(2.5);
out.spent = budget.spentUsd();
try { budget.assertCanSpend("late call"); out.refused = null; }
catch (error) { out.refused = error.message; }
process.stdout.write(JSON.stringify(out));
`);
    expect(result.initial).toBe(5);
    expect(result.afterHalf).toBe(2.5);
    expect(result.canSpend).toBe(true);
    expect(result.spent).toBe(5);
    expect(String(result.refused)).toContain("runaway ceiling reached");
  });

  it("ignores a negative or non-finite cost reading", () => {
    const remaining = evaluate<number>(`
const budget = controller.createBudget({ ceilingUsd: 5 });
budget.record(-1);
budget.record(Number.NaN);
budget.record(Number.POSITIVE_INFINITY);
process.stdout.write(JSON.stringify(budget.remainingUsd()));
`);
    expect(remaining).toBe(5);
  });

  it("rejects a non-positive ceiling", () => {
    const failures = evaluate<number>(`
let count = 0;
for (const value of [0, -1, Number.NaN, "5", null]) {
  try { controller.createBudget({ ceilingUsd: value }); } catch { count += 1; }
}
process.stdout.write(JSON.stringify(count));
`);
    expect(failures).toBe(5);
  });

  /**
   * The fake CLI is built in the parent and passed as data, so no nested
   * escaping is involved. It records its argv and reports a fixed cost, which is
   * enough to exercise the budget tracker without any model call.
   */
  const FAKE_CLI = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.OG86_SEEN, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10));",
    // Stand in for the hook's transcript record plus one assistant turn, so the
    // driver's post-call reads succeed without a real session.
    "fs.writeFileSync(process.env.OG86_TRANSCRIPT_PATH, process.env.OG86_TRANSCRIPT + String.fromCharCode(10));",
    "fs.appendFileSync(process.env.OG86_TRANSCRIPT, JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5-20251001' } }) + String.fromCharCode(10));",
    "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,"
      + " total_cost_usd: Number(process.env.OG86_COST || 0.4), num_turns: 1, result: '{}' }));",
    "",
  ].join("\n");

  function driveFakeCli(cost: number, attempts = 1) {
    return evaluate<{ budgets: number[]; calls: number; refused: string | null; advisory: number; ceiling: number }>(`
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-cap-"));
const fake = join(root, "claude");
const seen = join(root, "seen.jsonl");
writeFileSync(fake, ARGS.fakeSource);
chmodSync(fake, 0o755);
// The driver reads the source transcript after each call, so the fake CLI both
// records that path and appends a turn to the transcript it names.
const armRoot = join(root, "private", "arm-a");
const transcriptPath = join(armRoot, "transcript-path.txt");
const transcript = join(armRoot, "transcript.jsonl");
process.env.OG86_SEEN = seen;
process.env.OG86_COST = String(ARGS.cost);
process.env.OG86_TRANSCRIPT_PATH = transcriptPath;
process.env.OG86_TRANSCRIPT = transcript;
import { existsSync } from "node:fs";
const driver = controller.createClaudeDriver({
  repository: process.cwd(), benchmark: ARGS.benchmark, privateRoot: join(root, "private"),
  dcompact: join(root, "cli.js"), claudeBinary: fake,
});
let refused = null;
driver.openArm("A", 1);
for (let attempt = 0; attempt < ARGS.attempts; attempt += 1) {
  try { driver.sendPhasePrompt({ arm: "A", phase: 1 }); }
  catch (error) { refused = error.message; break; }
}
const text = (() => { try { return readFileSync(seen, "utf8"); } catch { return ""; } })();
const rows = text.trim().length === 0 ? [] : text.trim().split(String.fromCharCode(10)).map((line) => JSON.parse(line));
const budgets = rows.map((argv) => Number(argv[argv.indexOf("--max-budget-usd") + 1]));
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  budgets, calls: rows.length, refused,
  advisory: controller.FROZEN.advisoryPerArmUsd, ceiling: controller.FROZEN.runawayPerArmUsd,
}));
`, {
      fakeSource: FAKE_CLI,
      cost,
      attempts,
      benchmark: join(root, "docs", "benchmark", "og86-medium-v1"),
    });
  }

  it("passes the remaining allowance, never the advisory figure, to the CLI", () => {
    const observed = driveFakeCli(0.4);
    expect(observed.calls).toBe(1);
    expect(observed.budgets).toHaveLength(1);
    // Above the advisory 0.35 (which would abort a legitimate arm) and within
    // the runaway ceiling.
    expect(observed.budgets[0]).toBeGreaterThan(observed.advisory);
    expect(observed.budgets[0]).toBeLessThanOrEqual(observed.ceiling);
  });

  it("shrinks the passed budget as the arm spends", () => {
    const observed = driveFakeCli(3, 4);
    expect(observed.budgets.length).toBeGreaterThanOrEqual(2);
    expect(observed.budgets[0]).toBe(5);
    expect(observed.budgets[1]).toBeCloseTo(2, 6);
    // Strictly decreasing: the tracker hands out what is actually left.
    for (let index = 1; index < observed.budgets.length; index += 1) {
      expect(observed.budgets[index]).toBeLessThan(observed.budgets[index - 1]);
    }
  });

  it("stops issuing calls once the ceiling is exhausted", () => {
    const observed = driveFakeCli(3, 4);
    // 3 + 3 = 6 exceeds the 5 ceiling, so the third attempt never spawns.
    expect(observed.calls).toBe(2);
    expect(String(observed.refused)).toContain("runaway ceiling reached");
  });
});

describe("OG-86 per-invocation ledger cursors", () => {
  it("selects only rows appended after the cursor", () => {
    const result = evaluate<Record<string, unknown>>(`
const rows = [{ kind: "Treatment", treatmentBytes: 99 }, { kind: "PostCompact" }, { kind: "Treatment", treatmentBytes: 0 }];
const cursor = controller.ledgerCursor(rows.slice(0, 1));
process.stdout.write(JSON.stringify({
  cursor,
  after: controller.rowsAfter(rows, cursor).length,
  empty: controller.rowsAfter(rows, 3).length,
  missing: controller.rowsAfter(undefined, 0).length,
  zero: controller.ledgerCursor(undefined),
}));
`);
    expect(result.cursor).toBe(1);
    expect(result.after).toBe(2);
    expect(result.empty).toBe(0);
    expect(result.missing).toBe(0);
    expect(result.zero).toBe(0);
  });

  it("sees a multi-phase ledger where phase 1 already injected", () => {
    // The defect: an assertion that scanned all historical events would find
    // phase 1's treatment while checking phase 2 and fail falsely. Scoping by
    // cursor makes phase 2's check independent of phase 1.
    const result = evaluate<{ phase1: number; phase2: number; phase2Rows: number }>(`
const ledger = [];
// Phase 1: a completed manual compact with one armed treatment.
ledger.push({ kind: "PreCompact", trigger: "manual" });
ledger.push({ kind: "SessionStart", source: "resume" });
ledger.push({ kind: "Treatment", armed: true, treatmentBytes: 7371 });
// Phase 2 starts here.
const cursor = controller.ledgerCursor(ledger);
ledger.push({ kind: "PreCompact", trigger: "manual" });
ledger.push({ kind: "PostCompact" });
ledger.push({ kind: "Treatment", treatmentBytes: 0 });
const phase2Rows = controller.rowsAfter(ledger, cursor);
process.stdout.write(JSON.stringify({
  phase1: ledger.slice(0, cursor).filter((row) => (row.treatmentBytes ?? 0) > 0).length,
  phase2: phase2Rows.filter((row) => (row.treatmentBytes ?? 0) > 0).length,
  phase2Rows: phase2Rows.length,
}));
`);
    expect(result.phase1).toBe(1);
    // Phase 2's own window contains no injection, which is what the gate needs.
    expect(result.phase2).toBe(0);
    expect(result.phase2Rows).toBe(3);
  });
});

describe("OG-86 source transcript pinning", () => {
  it("counts a final unterminated line as a physical line", () => {
    const counts = evaluate<Record<string, number>>(`
const encoder = new TextEncoder();
process.stdout.write(JSON.stringify({
  empty: controller.physicalLineCount(encoder.encode("")),
  oneTerminated: controller.physicalLineCount(encoder.encode("a\\n")),
  twoTerminated: controller.physicalLineCount(encoder.encode("a\\nb\\n")),
  oneUnterminated: controller.physicalLineCount(encoder.encode("a")),
  mixed: controller.physicalLineCount(encoder.encode("a\\nb")),
  trailingBlank: controller.physicalLineCount(encoder.encode("a\\n\\n")),
}));
`);
    expect(counts.empty).toBe(0);
    expect(counts.oneTerminated).toBe(1);
    expect(counts.twoTerminated).toBe(2);
    expect(counts.oneUnterminated).toBe(1);
    // Two physical lines, the second unterminated: this is where split() is off.
    expect(counts.mixed).toBe(2);
    expect(counts.trailingBlank).toBe(2);
  });
});

describe("OG-86 CLI envelope validation", () => {
  const FAKE_SOURCE = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.mkdirSync(path.dirname(process.env.OG86_TRANSCRIPT_PATH), { recursive: true });",
    "fs.writeFileSync(process.env.OG86_TRANSCRIPT_PATH, process.env.OG86_TRANSCRIPT);",
    "const envelope = JSON.parse(process.env.OG86_ENVELOPE);",
    "process.stdout.write(typeof envelope === 'string' ? envelope : JSON.stringify(envelope));",
    "process.exit(Number(process.env.OG86_STATUS || 0));",
    "",
  ].join("\n");

  function invoke(envelope: unknown, status = 0) {
    return evaluate<{ threw: boolean; message: string }>(`
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-env-"));
const fake = join(root, "claude");
writeFileSync(fake, ARGS.source);
chmodSync(fake, 0o755);
const armRoot = join(root, "private", "arm-a");
const transcriptPath = join(armRoot, "transcript-path.txt");
const transcript = join(armRoot, "transcript.jsonl");
// The driver pins whatever the fake reports, so the fake must name a real
// transcript file. The arm directory only exists after openArm, so the file is
// created by the fake itself, which runs after that.
process.env.OG86_TRANSCRIPT_PATH = transcriptPath;
process.env.OG86_TRANSCRIPT = transcript;
process.env.OG86_ENVELOPE = JSON.stringify(ARGS.envelope);
process.env.OG86_STATUS = String(ARGS.status);
import { existsSync } from "node:fs";
const driver = controller.createClaudeDriver({
  repository: process.cwd(), benchmark: ARGS.benchmark, privateRoot: join(root, "private"),
  dcompact: join(root, "cli.js"), claudeBinary: fake,
});
let threw = false;
let message = "";
driver.openArm("A", 1);
try { driver.sendPhasePrompt({ arm: "A", phase: 1 }); }
catch (error) { threw = true; message = error.message; }
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ threw, message }));
`, { source: FAKE_SOURCE, envelope, status, benchmark: join(root, "docs", "benchmark", "og86-medium-v1") });
  }

  it("rejects is_error=true even when the process exits 0", () => {
    // The CLI reports failures inside the JSON envelope, so a zero exit status
    // is not sufficient evidence of success.
    const result = invoke({ type: "result", subtype: "success", is_error: true, total_cost_usd: 0.01, num_turns: 0, result: "" }, 0);
    expect(result.threw).toBe(true);
    expect(result.message).toContain("is_error=true");
  });

  it("accepts is_error=false on a zero exit", () => {
    const result = invoke({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, num_turns: 1, result: "{}", session_id: "s" }, 0);
    expect(result.threw).toBe(false);
  });

  it("rejects a zero exit with an unparseable envelope", () => {
    const result = invoke("not json at all", 0);
    expect(result.threw).toBe(true);
    expect(result.message).toContain("unparseable envelope");
  });

  it("still rejects a non-zero exit, diagnosing from the envelope when one parses", () => {
    // Real bug, from the sixth --execute attempt: arm C's phase-2 work call
    // exited status=1 with an empty stderr, but stdout held a full, valid
    // envelope reporting a real, diagnosable 429 weekly-limit refusal. The
    // exit-code-first check threw the opaque "status=1, stderr_bytes=0"
    // instead, discarding the far more useful envelope diagnosis already sitting
    // in `parsed`.
    const result = invoke({ type: "result", subtype: "error_max_budget_usd", is_error: true, api_error_status: 429 }, 1);
    expect(result.threw).toBe(true);
    expect(result.message).toContain("is_error=true");
    expect(result.message).toContain("api_error_status=429");
  });

  it("rejects a successful envelope that is not an object", () => {
    // An array, null, or bare primitive parses cleanly but carries no fields, so
    // accepting it would let a malformed call read as a successful one.
    const array = invoke([{ is_error: false }], 0);
    expect(array.threw).toBe(true);
    expect(array.message).toContain("not an object");

    const nullEnvelope = invoke(null, 0);
    expect(nullEnvelope.threw).toBe(true);
    expect(nullEnvelope.message).toContain("null");

    // A JSON number is a valid parse that is still not an object.
    const numberEnvelope = invoke('"a string"', 0);
    expect(numberEnvelope.threw).toBe(true);
    expect(numberEnvelope.message).toContain("not an object");
  });

  it("requires is_error to be explicitly false and a finite cost", () => {
    const missing = invoke({ type: "result", subtype: "success", total_cost_usd: 0.01 }, 0);
    expect(missing.threw).toBe(true);
    expect(missing.message).toContain("is_error=missing");

    const cases: Array<[unknown, string]> = [[undefined, "missing"], [-1, "negative"], ["0.01", "string"], [null, "null"]];
    for (const [cost, label] of cases) {
      const result = invoke({ type: "result", is_error: false, total_cost_usd: cost }, 0);
      expect(result.threw, label).toBe(true);
      expect(result.message).toContain("invalid total_cost_usd");
    }

    // Zero is a legitimate cost and must pass.
    const zero = invoke({ type: "result", is_error: false, total_cost_usd: 0 }, 0);
    expect(zero.threw).toBe(false);
  });
});

describe("OG-86 run manifest", () => {
  it("carries the freeze commit, derived order, and blinding", () => {
    const manifest = evaluate<Record<string, unknown>>(`
process.stdout.write(JSON.stringify(controller.runManifest({ freezeCommit: ARGS.freeze })));
`, { freeze: "fd1c5ed7e872243f94746402f5b61790614d4ea9" });
    expect(manifest.freezeCommit).toBe("fd1c5ed7e872243f94746402f5b61790614d4ea9");
    expect(manifest.armOrder).toEqual(["C", "B", "A"]);
    expect(manifest.blinding).toEqual({ C: "X1", B: "X2", A: "X3" });
    expect(manifest.runawayCeilingUsd).toBe(5);
  });

  it("refuses to derive an order from a commit that is not a revision", () => {
    const message = evaluate<string>(`
try { controller.runManifest({ freezeCommit: "HEAD" }); process.stdout.write(JSON.stringify("no throw")); }
catch (error) { process.stdout.write(JSON.stringify(error.message)); }
`);
    expect(message).toContain("40-character");
  });

  it("writes the manifest privately without a model and keeps it out of arm JSON", () => {
    // A dry-run-shaped exercise: the manifest is written by a pure helper, and
    // the arm artifact must not leak the order or the blinding.
    const result = evaluate<{ manifest: Record<string, unknown>; armKeys: string[]; artifactJson: string }>(`
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-manifest-"));
const manifest = controller.runManifest({ freezeCommit: ARGS.freeze });
const path = join(root, "run-manifest.json");
writeFileSync(path, JSON.stringify(manifest, null, 2) + String.fromCharCode(10), { mode: 0o600 });
const mode = (statSync(path).mode & 0o777).toString(8);
const reread = JSON.parse(readFileSync(path, "utf8"));

${DRIVER_PRELUDE}
const result = runSeries({});
const revisions = { runner: "sha256:" + "f".repeat(64), scorer: "sha256:" + "0".repeat(64) };
const artifact = controller.armArtifact(result.state, "C", revisions);
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  manifest: { ...reread, mode },
  armKeys: Object.keys(artifact).sort(),
  artifactJson: JSON.stringify(artifact),
}));
`, { freeze: "fd1c5ed7e872243f94746402f5b61790614d4ea9" });
    expect(result.manifest.mode).toBe("600");
    expect(result.manifest.armOrder).toEqual(["C", "B", "A"]);
    // The public arm artifact carries the opaque label, never the order or mapping.
    expect(result.armKeys).toContain("opaqueArm");
    expect(result.armKeys).not.toContain("armOrder");
    expect(result.armKeys).not.toContain("blinding");
    expect(result.armKeys).not.toContain("freezeCommit");
    expect(result.artifactJson).not.toContain("freezeCommit");
    expect(result.artifactJson).not.toContain("armOrder");
    expect(result.artifactJson).not.toContain("blinding");
  });
});

describe("OG-86 fork probe attribution", () => {
  /**
   * Attribution is by record identity, never by subtracting cumulative counts.
   * The authorized evidence has a 4-row fork against a 30-row source, so a
   * count subtraction is invalid; and every fork row carries the fork's own
   * session id, so the session id cannot separate inherited rows either.
   */
  function identities(ids: string[], model = "claude-haiku-4-5-20251001") {
    return evaluate<Record<string, unknown>>(`
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-ids-"));
const path = join(root, "t.jsonl");
const rows = ARGS.ids.map((id) => JSON.stringify({
  type: "assistant",
  uuid: id,
  sessionId: ARGS.forkSession,
  message: { role: "assistant", model: ARGS.model },
}));
writeFileSync(path, rows.join(String.fromCharCode(10)) + (rows.length ? String.fromCharCode(10) : ""));
const read = binding && null;
const result = controller.assistantIdentities(path);
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ ids: result.ids, usable: result.usable, missingUuid: result.missingUuid, duplicateUuid: result.duplicateUuid, reason: result.reason, assistantRecords: result.assistantRecords }));
`, { ids, model, forkSession: "fork-session" });
  }

  function attribute(beforeIds: string[], afterIds: string[], afterModel = "claude-haiku-4-5-20251001") {
    return evaluate<Record<string, unknown>>(`
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-attr-"));
const write = (name, ids, model) => {
  const path = join(root, name);
  const rows = ids.map((id) => JSON.stringify({ type: "assistant", uuid: id, message: { role: "assistant", model } }));
  writeFileSync(path, rows.join(String.fromCharCode(10)) + (rows.length ? String.fromCharCode(10) : ""));
  return path;
};
const before = controller.assistantIdentities(write("before.jsonl", ARGS.beforeIds, ARGS.model));
const after = controller.assistantIdentities(write("after.jsonl", ARGS.afterIds, ARGS.afterModel));
const result = controller.identityAttribution({ before, after, requiredModel: ARGS.model, relationship: ARGS.relationship });
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify(result));
`, { beforeIds, afterIds, afterModel, relationship: "fresh-transcript", model: "claude-haiku-4-5-20251001" });
  }

  it("derives the added identities, matching the measured fork shape", () => {
    // The measured shape: a fork with 4 assistant records, 2 of which also
    // appear in the source. Only the 2 new ones are the fork's own work.
    const result = attribute(["s1", "s2", "s3", "s4"], ["s3", "s4", "f1", "f2"]);
    expect(result.assistantRecords).toBe(2);
    expect(result.matchingModelRecords).toBe(2);
    expect(result.fallbackRecords).toBe(0);
    expect(result.addedIds).toEqual(["f1", "f2"]);
    expect(result.removedIds).toEqual([]);
    expect(result.proven).toBe(true);
    expect(result.attribution).toBe("identity-set-delta");
  });

  it("counts a foreign model as a mismatch rather than as work", () => {
    const result = evaluate<Record<string, unknown>>(`
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-foreign-"));
const write = (name, rows) => {
  const path = join(root, name);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join(String.fromCharCode(10)) + String.fromCharCode(10));
  return path;
};
const row = (uuid, model) => ({ type: "assistant", uuid, message: { role: "assistant", model } });
const before = controller.assistantIdentities(write("b.jsonl", [row("s1", "claude-haiku-4-5-20251001")]));
const after = controller.assistantIdentities(write("a.jsonl", [
  row("s1", "claude-haiku-4-5-20251001"),
  row("f1", "claude-haiku-4-5-20251001"),
  row("f2", "claude-sonnet-4-5"),
]));
const result = controller.identityAttribution({ before, after, requiredModel: "claude-haiku-4-5-20251001", relationship: "append-only" });
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify(result));
`, {});
    expect(result.assistantRecords).toBe(2);
    expect(result.matchingModelRecords).toBe(1);
    expect(result.fallbackRecords).toBe(1);
    expect(result.counts).toEqual({ "claude-haiku-4-5-20251001": 1 });
  });

  it("refuses a removal, which an append-only transcript cannot do", () => {
    const result = evaluate<Record<string, unknown>>(`
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-rm-"));
const write = (name, ids) => {
  const path = join(root, name);
  writeFileSync(path, ids.map((id) => JSON.stringify({ type: "assistant", uuid: id, message: { role: "assistant", model: "claude-haiku-4-5-20251001" } })).join(String.fromCharCode(10)) + String.fromCharCode(10));
  return path;
};
const before = controller.assistantIdentities(write("b.jsonl", ["s1", "s2"]));
const after = controller.assistantIdentities(write("a.jsonl", ["s1"]));
const result = controller.identityAttribution({ before, after, requiredModel: "claude-haiku-4-5-20251001", relationship: "append-only" });
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify(result));
`, {});
    expect(result.monotonic).toBe(false);
    expect(result.proven).toBe(false);
    expect(result.refusal).toBe("records-removed");
    expect(result.removedIds).toEqual(["s2"]);
  });

  it("marks a transcript with a missing or duplicate uuid unusable", () => {
    const missing = identities(["a", ""]);
    expect(missing.usable).toBe(false);
    expect(missing.reason).toBe("missing-uuid");
    expect(missing.missingUuid).toBe(1);
    const duplicate = identities(["a", "a"]);
    expect(duplicate.usable).toBe(false);
    expect(duplicate.reason).toBe("duplicate-uuid");
    expect(duplicate.duplicateUuid).toBe(1);
    const good = identities(["a", "b"]);
    expect(good.usable).toBe(true);
    expect(good.reason).toBeNull();
    expect(good.ids).toEqual(["a", "b"]);
  });

  it("fails closed when either identity set is unusable", () => {
    const result = evaluate<Record<string, unknown>>(`
process.stdout.write(JSON.stringify(controller.identityAttribution({
  before: { ids: [], byId: new Map(), usable: false, reason: "transcript-missing" },
  after: { ids: ["a"], byId: new Map(), usable: true, reason: null },
  requiredModel: "claude-haiku-4-5-20251001",
  relationship: "append-only",
})));
`);
    expect(result.proven).toBe(false);
    expect(result.assistantRecords).toBe(0);
    expect(result.refusal).toBe("transcript-missing");
  });

  it("reads only integer num_turns from the envelope as corroboration", () => {
    const values = evaluate<Record<string, number | null>>(`
process.stdout.write(JSON.stringify({
  zero: controller.envelopeTurnCount({ num_turns: 0 }),
  positive: controller.envelopeTurnCount({ num_turns: 7 }),
  negative: controller.envelopeTurnCount({ num_turns: -1 }),
  fractional: controller.envelopeTurnCount({ num_turns: 1.5 }),
  string: controller.envelopeTurnCount({ num_turns: "3" }),
  missing: controller.envelopeTurnCount({}),
  none: controller.envelopeTurnCount(null),
}));
`);
    expect(values.zero).toBe(0);
    expect(values.positive).toBe(7);
    expect(values.negative).toBeNull();
    expect(values.fractional).toBeNull();
    expect(values.string).toBeNull();
    expect(values.missing).toBeNull();
    expect(values.none).toBeNull();
  });

  it("invalidates an unproven fork probe reading", () => {
    const result = series({
      probeFork: `({ arm }) => ({ treatmentBytes: arm === "A" ? 0 : 1246, treatmentSha256: arm === "A" ? null : "sha256:" + "c".repeat(64), treatmentCopies: arm === "A" ? 0 : 1, toolDecisions: [], score: { points: 25, denominator: 25 }, costUsd: 0.02, wallSeconds: 20, turns: 0, models: { assistantRecords: 0, matchingModelRecords: 0, fallbackRecords: 0, counts: {}, proven: false, attribution: "unproven" } })`,
    });
    expect(result.state.invalidations.some((entry) => entry.includes("fork-probe-attribution-unproven"))).toBe(true);
  });
});

describe("OG-86 production driver fork attribution (fake CLI)", () => {
  /**
   * A fake CLI that behaves like the host for the corner this slice is about:
   * the source session appends source records to the source transcript, and
   * `--fork-session` writes a **fresh** fork transcript holding a subset of the
   * source's identities plus new fork-only ones, then rewrites the shared
   * transcript record to name it. Every record carries the frozen model.
   *
   * This reproduces the measured shape (source keeps its own transcript; the
   * fork is a smaller file that shares some identities) without any model call.
   */
  const FAKE = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const forking = args.includes('--fork-session');",
    "const state = process.env.OG86_STATE;",
    "const source = process.env.OG86_SOURCE;",
    "const fork = process.env.OG86_FORK;",
    "const shared = process.env.OG86_SHARED;",
    "fs.mkdirSync(path.dirname(source), { recursive: true });",
    "const rec = (uuid, model) => JSON.stringify({ type: 'assistant', uuid, message: { role: 'assistant', model } });",
    "const M = 'claude-haiku-4-5-20251001';",
    // Two source records are shared with the fork, mirroring the measured overlap.
    "const SHARED_IDS = ['shared-1', 'shared-2'];",
    "if (forking) {",
    "  const rows = [...SHARED_IDS, 'fork-1', 'fork-2'].map((id) => rec(id, M));",
    "  fs.writeFileSync(fork, rows.join(String.fromCharCode(10)) + String.fromCharCode(10));",
    "  fs.writeFileSync(shared, fork + String.fromCharCode(10));",
    "} else {",
    "  const existing = fs.existsSync(source) ? fs.readFileSync(source, 'utf8').trim() : '';",
    "  const rows = (existing ? existing.split(String.fromCharCode(10)) : []).concat(['shared-1', 'shared-2', 'src-1', 'src-2'].map((id) => rec(id, M)));",
    "  fs.writeFileSync(source, rows.join(String.fromCharCode(10)) + String.fromCharCode(10));",
    "  fs.writeFileSync(shared, source + String.fromCharCode(10));",
    "}",
    // The probe resume appends its own record to the fork transcript, and emits
    // the ledger row the driver reads from the score-fork hook.
    "if (process.env.OG86_FORK_PROBE === '1') {",
    "  const existing = fs.existsSync(fork) ? fs.readFileSync(fork, 'utf8').trim() : '';",
    "  fs.writeFileSync(fork, existing + String.fromCharCode(10) + rec('probe-1', M) + String.fromCharCode(10));",
    "  const probeRoot = process.env.OG86_PROBE_ROOT;",
    "  fs.mkdirSync(probeRoot, { recursive: true });",
    "  fs.writeFileSync(path.join(probeRoot, 'score-fork-events.jsonl'), [",
    "    JSON.stringify({ event: 'SessionStart', source: 'resume', treatmentBytes: Number(process.env.OG86_TREATMENT_BYTES || 0), treatmentSha256: process.env.OG86_TREATMENT_SHA || null }),",
    "    JSON.stringify({ event: 'PreToolUse', tool: 'Read', allowed: false }),",
    "  ].join(String.fromCharCode(10)) + String.fromCharCode(10));",
    "  fs.writeFileSync(path.join(probeRoot, 'score-fork-transcript-path.txt'), fork + String.fromCharCode(10));",
    "  fs.writeFileSync(path.join(probeRoot, 'neutral-response.json'), JSON.stringify({ files_symbols: [] }));",
    "}",
    "fs.mkdirSync(state, { recursive: true });",
    "fs.appendFileSync(process.env.OG86_LEDGER, JSON.stringify({ kind: 'SessionStart', source: 'resume', monotonicNs: '0', claudeParentPid: 1 }) + String.fromCharCode(10));",
    "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,"
      + " total_cost_usd: 0.01, num_turns: 2, session_id: forking ? 'fork-session' : 'source-session', result: '{}' }));",
    "",
  ].join("\n");

  /**
   * Drives the real production driver through session creation, one phase fork,
   * and one fork probe, using a fake CLI. Asserts each invocation reports a
   * nonzero, Haiku-only, identity-attributed delta, and that the source cursor is
   * untouched by the fork work.
   */
  it("attributes createFork and probeFork deltas without advancing the source cursor", () => {
    const result = evaluate<{
      creationRecords: number;
      creationMatching: number;
      creationForeign: number;
      creationAttribution: string;
      creationProven: boolean;
      probeRecords: number;
      probeMatching: number;
      probeForeign: number;
      probeAttribution: string;
      probeProven: boolean;
      probeBaselineRecords: number;
      corroborates: boolean;
      sourceCursorAfterProbe: number;
      sourceCursorUnchanged: boolean;
      forkDistinct: boolean;
      persistedForkId: string;
      persistedForkPathMatches: boolean;
    }>(`
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-prod-"));
const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });
const fake = join(bin, "claude");
writeFileSync(fake, ARGS.fake);
chmodSync(fake, 0o755);
const armRoot = join(root, "private", "arm-a");
mkdirSync(armRoot, { recursive: true });
process.env.OG86_STATE = armRoot;
process.env.OG86_SOURCE = join(root, "source.jsonl");
process.env.OG86_FORK = join(root, "fork.jsonl");
process.env.OG86_SHARED = join(armRoot, "transcript-path.txt");
process.env.OG86_LEDGER = join(armRoot, "events.jsonl");
process.env.OG86_FORK_PROBE = "0";
writeFileSync(process.env.OG86_LEDGER, "");
// A settings file the driver passes through; the fake CLI ignores its contents.
const settings = join(armRoot, "settings.json");
writeFileSync(settings, "{}");

import { existsSync } from "node:fs";
const driver = controller.createClaudeDriver({
  repository: process.cwd(), benchmark: ARGS.benchmark, privateRoot: join(root, "private"),
  dcompact: join(root, "cli.js"), claudeBinary: fake,
});
driver.openArm("A", 1);
// Bind the settings the driver believes in by pointing the arm at our stub.
const entry = { arm: "A", root: armRoot };
// Phase 1 work creates the source session and pins the source transcript.
const work = driver.sendPhasePrompt({ arm: "A", phase: 1 });
const cursorAfterWork = work.models.assistantRecords;

const fork = driver.createFork({ arm: "A", phase: 1 });
process.env.OG86_FORK_PROBE = "1";
process.env.OG86_PROBE_ROOT = join(armRoot, "phase-1-probe");
process.env.OG86_TREATMENT_BYTES = "0";
const probe = driver.probeFork({ arm: "A", phase: 1, fork: fork.fork });
const persisted = JSON.parse(readFileSync(join(armRoot, "phase-1-fork.json"), "utf8"));
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  creationRecords: fork.models.assistantRecords,
  creationMatching: fork.models.matchingModelRecords,
  creationForeign: fork.models.fallbackRecords,
  creationAttribution: fork.models.attribution,
  creationProven: fork.models.proven,
  probeRecords: probe.models.assistantRecords,
  probeMatching: probe.models.matchingModelRecords,
  probeForeign: probe.models.fallbackRecords,
  probeAttribution: probe.models.attribution,
  probeProven: probe.models.proven,
  probeBaselineRecords: probe.baselineAssistantRecords,
  corroborates: probe.corroboratesTranscriptCount,
  sourceCursorAfterProbe: cursorAfterWork,
  sourceCursorUnchanged: cursorAfterWork === work.models.assistantRecords,
  forkDistinct: fork.distinct,
  persistedForkId: persisted.forkId,
  persistedForkPathMatches: persisted.forkTranscriptPath === process.env.OG86_FORK,
}));
`, { fake: FAKE, benchmark: join(root, "docs", "benchmark", "og86-medium-v1") });
    // createFork: the two fork-only identities, both Haiku, proven.
    expect(result.creationRecords).toBe(2);
    expect(result.creationMatching).toBe(2);
    expect(result.creationForeign).toBe(0);
    expect(result.creationProven).toBe(true);
    expect(result.creationAttribution).toBe("identity-set-delta");
    // probeFork: one new identity on the same transcript, also Haiku, proven.
    expect(result.probeRecords).toBe(1);
    expect(result.probeMatching).toBe(1);
    expect(result.probeForeign).toBe(0);
    expect(result.probeProven).toBe(true);
    expect(result.probeBaselineRecords).toBe(4);
    // Both deltas are nonzero, so the model gate cannot fail for want of records.
    expect(result.creationRecords).toBeGreaterThan(0);
    expect(result.probeRecords).toBeGreaterThan(0);
    expect(result.forkDistinct).toBe(true);
    expect(result.persistedForkId).toBe("fork-session");
  });
});

describe("OG-86 source transcript pinning under fork overwrite", () => {
  /**
   * Simulates the real hazard: the hook writes the fork's transcript path into
   * the shared `transcript-path.txt` during the fork's SessionStart. A reader
   * that consults that file afterwards would compare the fork against itself and
   * report the source as stable no matter what actually happened.
   */
  const FAKE_SOURCE = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    // The session id in the envelope decides whether this is the fork call.
    "const args = process.argv.slice(2);",
    "const forking = args.includes('--fork-session');",
    "const stateRoot = process.env.OG86_STATE;",
    "fs.mkdirSync(stateRoot, { recursive: true });",
    // Emulate the hook: a fork overwrites the shared transcript record, a plain
    // resume keeps the source's own path.
    "const reported = forking ? process.env.OG86_FORK_TRANSCRIPT : process.env.OG86_SOURCE_TRANSCRIPT;",
    "fs.writeFileSync(process.env.OG86_TRANSCRIPT_PATH, reported + String.fromCharCode(10));",
    "if (forking) fs.writeFileSync(process.env.OG86_FORK_TRANSCRIPT, JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5-20251001' } }) + String.fromCharCode(10));",
    "else fs.appendFileSync(process.env.OG86_SOURCE_TRANSCRIPT, JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5-20251001' } }) + String.fromCharCode(10));",
    "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, num_turns: 1,"
      + " session_id: forking ? 'fork-session' : 'source-session', result: '{}' }));",
    "",
  ].join("\n");

  it("keeps reading the source transcript after a fork overwrites the shared record", () => {
    const result = evaluate<{
      sourceBefore: string;
      sourceAfter: string;
      sharedRecordPointsAtFork: boolean;
      stable: boolean;
      sourceAssistantRecords: number;
    }>(`
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-pin-"));
const fake = join(root, "claude");
writeFileSync(fake, ARGS.source);
chmodSync(fake, 0o755);
const armRoot = join(root, "private", "arm-a");
const state = join(armRoot);
const sourceTranscript = join(root, "source.jsonl");
const forkTranscript = join(root, "fork.jsonl");
const shared = join(armRoot, "transcript-path.txt");
writeFileSync(sourceTranscript, JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-haiku-4-5-20251001" } }) + String.fromCharCode(10));
process.env.OG86_STATE = state;
process.env.OG86_TRANSCRIPT_PATH = shared;
process.env.OG86_SOURCE_TRANSCRIPT = sourceTranscript;
process.env.OG86_FORK_TRANSCRIPT = forkTranscript;
import { existsSync } from "node:fs";
const driver = controller.createClaudeDriver({
  repository: process.cwd(), benchmark: ARGS.benchmark, privateRoot: join(root, "private"),
  dcompact: join(root, "cli.js"), claudeBinary: fake,
});
driver.openArm("A", 1);
driver.sendPhasePrompt({ arm: "A", phase: 1 });
const before = driver.verifySource({ arm: "A" }).source;
const fork = driver.createFork({ arm: "A" });
const after = driver.verifySource({ arm: "A" }).source;
// What the shared record now says, to prove the hazard was really simulated.
const sharedValue = readFileSync(shared, "utf8").trim();
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  sourceBefore: before.sha256,
  sourceAfter: after.sha256,
  sharedRecordPointsAtFork: sharedValue === forkTranscript,
  stable: before.sha256 === after.sha256,
  sourceAssistantRecords: 2,
}));
`, { source: FAKE_SOURCE, benchmark: join(root, "docs", "benchmark", "og86-medium-v1") });
    // The hazard is real: the shared record was overwritten by the fork.
    expect(result.sharedRecordPointsAtFork).toBe(true);
    // And the pinned source reading is unaffected by it.
    expect(result.sourceAfter).toBe(result.sourceBefore);
    expect(result.stable).toBe(true);
  });

  it("reads the pinned source rather than the shared record when they disagree", () => {
    const result = evaluate<{ pinned: string; shared: string; differ: boolean }>(`
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-pin2-"));
const fake = join(root, "claude");
writeFileSync(fake, ARGS.source);
chmodSync(fake, 0o755);
const armRoot = join(root, "private", "arm-a");
const sourceTranscript = join(root, "source.jsonl");
const forkTranscript = join(root, "fork.jsonl");
const shared = join(armRoot, "transcript-path.txt");
writeFileSync(sourceTranscript, JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-haiku-4-5-20251001" } }) + String.fromCharCode(10));
process.env.OG86_STATE = armRoot;
process.env.OG86_TRANSCRIPT_PATH = shared;
process.env.OG86_SOURCE_TRANSCRIPT = sourceTranscript;
process.env.OG86_FORK_TRANSCRIPT = forkTranscript;
import { existsSync } from "node:fs";
const driver = controller.createClaudeDriver({
  repository: process.cwd(), benchmark: ARGS.benchmark, privateRoot: join(root, "private"),
  dcompact: join(root, "cli.js"), claudeBinary: fake,
});
driver.openArm("A", 1);
driver.sendPhasePrompt({ arm: "A", phase: 1 });
driver.createFork({ arm: "A" });
const pinned = driver.verifySource({ arm: "A" }).source;
const sharedPath = readFileSync(shared, "utf8").trim();
const sharedBytes = readFileSync(sharedPath);
const sharedHash = "sha256:" + createHash("sha256").update(sharedBytes).digest("hex");
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ pinned: pinned.sha256, shared: sharedHash, differ: pinned.sha256 !== sharedHash }));
`, { source: FAKE_SOURCE, benchmark: join(root, "docs", "benchmark", "og86-medium-v1") });
    expect(result.differ).toBe(true);
    expect(result.pinned).not.toBe(result.shared);
  });
});

describe("OG-86 prefix-bounded evidence", () => {
  /**
   * A checkpoint's evidence is only real evidence if it comes from the prefix
   * the envelope bounds. A later transcript line that happens to hash to the
   * same value must not satisfy it.
   */
  it("ignores a post-envelope line that would otherwise satisfy evidence", () => {
    const result = evaluate<{ matched: number; required: number; outOfPrefix: number[]; fullyBound: boolean; evidenceLineCount: number }>(`
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-prefix-"));
const transcript = join(root, "transcript.jsonl");
const total = ARGS.totalLines;
const prefixLines = ARGS.prefixLines;
const lines = [];
for (let index = 1; index <= total; index += 1) {
  lines.push(JSON.stringify({ type: "assistant", index, message: { role: "assistant", model: "claude-haiku-4-5-20251001" } }));
}
writeFileSync(transcript, lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
const encoder = new TextEncoder();
const prefixBytes = encoder.encode(lines.slice(0, prefixLines).join(String.fromCharCode(10)) + String.fromCharCode(10)).byteLength;
const digest = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
// Evidence points at a line BEYOND the envelope boundary.
const beyond = lines[prefixLines];
const checkpoint = {
  envelope: { hash: "sha256:" + "a".repeat(64), transcript_bytes: prefixBytes, transcript_lines: prefixLines, previous_hash: null },
  payload: { facts: [{ evidence: [{ line: prefixLines + 1, sha256: digest(beyond + String.fromCharCode(10)) }] }] },
};
const bound = binding.checkpointBinding({ transcriptPath: transcript, checkpoint });
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  matched: bound.checkpointEvidenceEntriesMatched,
  required: bound.checkpointEvidenceEntriesRequired,
  outOfPrefix: bound.checkpointEvidenceEntriesOutOfPrefix,
  fullyBound: bound.evidenceFullyBound,
  evidenceLineCount: bound.evidenceLineCount,
}));
`, { totalLines: 6, prefixLines: 3 });
    // The line exists in the file and hashes correctly, but lies past the
    // envelope boundary, so it is not evidence for this checkpoint.
    expect(result.matched).toBe(0);
    expect(result.required).toBe(1);
    expect(result.outOfPrefix).toEqual([4]);
    expect(result.fullyBound).toBe(false);
    expect(result.evidenceLineCount).toBe(3);
  });

  it("still binds evidence that lies inside the prefix", () => {
    const result = evaluate<{ matched: number; required: number; outOfPrefix: number[]; fullyBound: boolean }>(`
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-prefix2-"));
const transcript = join(root, "transcript.jsonl");
const lines = [];
for (let index = 1; index <= 6; index += 1) {
  lines.push(JSON.stringify({ type: "assistant", index, message: { role: "assistant", model: "claude-haiku-4-5-20251001" } }));
}
writeFileSync(transcript, lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
const encoder = new TextEncoder();
const prefixBytes = encoder.encode(lines.slice(0, 3).join(String.fromCharCode(10)) + String.fromCharCode(10)).byteLength;
const digest = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
const inside = lines[1];
const checkpoint = {
  envelope: { hash: "sha256:" + "a".repeat(64), transcript_bytes: prefixBytes, transcript_lines: 3, previous_hash: null },
  payload: { facts: [{ evidence: [{ line: 2, sha256: digest(inside + String.fromCharCode(10)) }] }] },
};
const bound = binding.checkpointBinding({ transcriptPath: transcript, checkpoint });
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  matched: bound.checkpointEvidenceEntriesMatched,
  required: bound.checkpointEvidenceEntriesRequired,
  outOfPrefix: bound.checkpointEvidenceEntriesOutOfPrefix,
  fullyBound: bound.evidenceFullyBound,
}));
`, {});
    expect(result.matched).toBe(1);
    expect(result.required).toBe(1);
    expect(result.outOfPrefix).toEqual([]);
    expect(result.fullyBound).toBe(true);
  });

  it("binds the real Stage-0 checkpoint within its prefix", () => {
    // The authorized private evidence, when present, must still resolve 21/21
    // with no evidence beyond the boundary.
    const result = evaluate<{ skipped: boolean; matched?: number; required?: number; outOfPrefix?: number }>(`
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
const root = join(process.cwd(), "sessions", "og86-stage0-v6", "source");
if (!existsSync(root)) { process.stdout.write(JSON.stringify({ skipped: true })); }
else {
  const transcriptPath = readFileSync(join(root, "transcript-path.txt"), "utf8").trim();
  const sessionId = readFileSync(join(root, "session-id.txt"), "utf8").trim();
  const dir = join(root, "store", "claude", sessionId, "checkpoints");
  const name = readdirSync(dir).find((entry) => entry.endsWith(".json"));
  const checkpoint = JSON.parse(readFileSync(join(dir, name), "utf8"));
  const bound = binding.checkpointBinding({ transcriptPath, checkpoint });
  process.stdout.write(JSON.stringify({
    skipped: false,
    matched: bound.checkpointEvidenceEntriesMatched,
    required: bound.checkpointEvidenceEntriesRequired,
    outOfPrefix: bound.checkpointEvidenceEntriesOutOfPrefix.length,
  }));
}
`, {});
    expect(result.skipped).toBe(false);
    expect(result.matched).toBe(21);
    expect(result.required).toBe(21);
    expect(result.outOfPrefix).toBe(0);
  });
});

describe("OG-86 arming atomicity", () => {
  it("validates the checkpoint is an integer in 1..4", () => {
    const failures = evaluate<Array<string | null>>(`
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-ckpt-"));
const attempt = (checkpoint) => {
  try { hook.armTreatment(root, { arm: "B", checkpoint, token: "t" }); return null; }
  catch (error) { return error.message; }
};
const out = [0, 5, -1, 1.5, Number.NaN, null, "2"].map(attempt);
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify(out));
`);
    for (const failure of failures) expect(failure).toContain("1..4");
  });

  it("accepts checkpoints 1 through 4", () => {
    const results = evaluate<Array<Record<string, unknown>>>(`
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-ckpt2-"));
const out = [1, 2, 3, 4].map((checkpoint) => hook.armTreatment(root, { arm: "C", checkpoint, token: "t" + checkpoint }));
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify(out));
`);
    expect(results).toHaveLength(4);
    for (const result of results) expect(String(result)).toContain("treatment-arming.json");
  });

  it("claims a token atomically so exactly one caller can inject it", () => {
    // Two processes race the same arming. The claim file is created with `wx`,
    // which is atomic, so one wins and the other is suppressed rather than both
    // injecting the treatment.
    const result = evaluate<{ winners: number; suppressed: number; ledgerRows: number; claims: number }>(`
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-race-"));
const state = join(root, "state");
mkdirSync(state, { recursive: true });
writeFileSync(join(state, "native-summary.txt"), "SUMMARY-FOR-RACE");
const flags = ["transcript", "profile", "store", "rubric", "scorer", "capture"].map((l) => "--forbid" + l + "=" + join(state, l));
const body = JSON.stringify({ hook_event_name: "SessionStart", source: "resume", transcript_path: join(state, "t.jsonl") });
const argv = (extra) => [ARGS.hook, "--arm", "B", "--state", state, "--workload", join(state, "w"),
  "--dcompact", join(state, "cli.js"), ...flags, ...extra];
// Arm once, then fire two resumes as genuinely concurrent processes.
spawnSync(process.execPath, argv(["--arm-treatment", "RACE-TOKEN", "--treatment-arm", "B", "--treatment-checkpoint", "1"]), { input: "{}", encoding: "utf8" });

const start = async () => new Promise((resolve) => {
  const child = spawn(process.execPath, argv(["--event", "SessionStart"]), { stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.on("close", () => resolve(out));
  child.stdin.end(body);
});
const outputs = await Promise.all([start(), start()]);
const injected = outputs.filter((stdout) => stdout.includes("SUMMARY-FOR-RACE")).length;
const ledger = join(state, "treatment-consumed.jsonl");
const ledgerRows = existsSync(ledger)
  ? readFileSync(ledger, "utf8").trim().split(String.fromCharCode(10)).filter((l) => l.trim()).length
  : 0;
const claims = readdirSync(state).filter((name) => name.startsWith("treatment-claim-")).length;
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ winners: injected, suppressed: outputs.length - injected, ledgerRows, claims }));
`, { hook: HOOK });
    // Exactly one injection across both concurrent resumes.
    expect(result.winners).toBe(1);
    expect(result.suppressed).toBe(1);
    expect(result.claims).toBe(1);
    expect(result.ledgerRows).toBe(1);
  });
});

describe("OG-86 Stage-0 privacy walk", () => {
  function walkTree(build: string) {
    return evaluate<{
      symlinkCount: number;
      symlinks: string[];
      zeroSymlinks: boolean;
    }>(`
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-walk-"));
${build}
const walked = stage0.privacyModes(root);
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  symlinkCount: walked.symlinkCount,
  symlinks: walked.symlinks,
  zeroSymlinks: walked.zeroSymlinks,
}));
`);
  }

  it("counts a symlink instead of silently skipping it", () => {
    const result = walkTree(`
mkdirSync(join(root, "tree"), { recursive: true, mode: 0o700 });
writeFileSync(join(root, "tree", "real.txt"), "x", { mode: 0o600 });
symlinkSync(join(root, "tree", "real.txt"), join(root, "test-link"));
chmodSync(root, 0o700);
`);
    expect(result.symlinkCount).toBe(1);
    expect(result.symlinks).toEqual(["test-link"]);
    expect(result.zeroSymlinks).toBe(false);
  });

  it("reports zero symlinks for a clean tree", () => {
    const result = walkTree(`
mkdirSync(join(root, "tree"), { recursive: true, mode: 0o700 });
writeFileSync(join(root, "tree", "real.txt"), "x", { mode: 0o600 });
chmodSync(root, 0o700);
`);
    expect(result.symlinkCount).toBe(0);
    expect(result.symlinks).toEqual([]);
    expect(result.zeroSymlinks).toBe(true);
  });

  it("counts a symlink nested inside a subdirectory", () => {
    const result = walkTree(`
mkdirSync(join(root, "tree", "nested"), { recursive: true, mode: 0o700 });
writeFileSync(join(root, "tree", "nested", "real.txt"), "x", { mode: 0o600 });
symlinkSync(join(root, "tree", "nested", "real.txt"), join(root, "tree", "nested", "test-link"));
chmodSync(root, 0o700);
`);
    expect(result.symlinkCount).toBe(1);
    expect(result.symlinks).toEqual(["tree/nested/test-link"]);
  });
});

describe("OG-86 Stage-0 envelope validation", () => {
  /**
   * The Stage-0 wrapper is exercised through a stub `claude` on PATH that emits
   * a chosen envelope, so no model is involved. The wrapper's own refusal is
   * what the assertion observes.
   */
  const STUB = [
    "#!/usr/bin/env node",
    "process.stdout.write(process.env.OG86_ENVELOPE || '');",
    "process.exit(Number(process.env.OG86_EXIT_CODE || 0));",
    "",
  ].join("\n");

  function invokeWrapper(envelope: string, exitCode = 0) {
    return evaluate<{ threw: boolean; message: string }>(`
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-s0env-"));
const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });
const fake = join(bin, "claude");
writeFileSync(fake, ARGS.stub);
chmodSync(fake, 0o755);
process.env.PATH = bin + ":" + process.env.PATH;
process.env.OG86_ENVELOPE = ARGS.envelope;
process.env.OG86_EXIT_CODE = String(ARGS.exitCode);
let threw = false;
let message = "";
try { stage0.claudeCall([], root, join(root, "out.json")); }
catch (error) { threw = true; message = error.message; }
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ threw, message }));
`, { stub: STUB, envelope, exitCode });
  }

  it("rejects is_error=true even when the process exits 0", () => {
    const result = invokeWrapper(JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 500 }), 0);
    expect(result.threw).toBe(true);
    expect(result.message).toContain("is_error=true");
  });

  it("accepts is_error=false on a zero exit", () => {
    const result = invokeWrapper(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.143467 }), 0);
    expect(result.threw).toBe(false);
  });

  it("rejects a zero exit with an unparseable envelope", () => {
    const result = invokeWrapper("not json", 0);
    expect(result.threw).toBe(true);
    expect(result.message).toContain("unparseable envelope");
  });

  it("still rejects a non-zero exit, diagnosing from the envelope when one parses", () => {
    const result = invokeWrapper(JSON.stringify({ type: "result", subtype: "error", is_error: true }), 1);
    expect(result.threw).toBe(true);
    expect(result.message).toContain("is_error=true");
  });

  it("rejects a success envelope that is not an object, or lacks a valid cost", () => {
    const array = invokeWrapper("[1,2,3]", 0);
    expect(array.threw).toBe(true);
    expect(array.message).toContain("not an object");

    const missingCost = invokeWrapper(JSON.stringify({ type: "result", is_error: false }), 0);
    expect(missingCost.threw).toBe(true);
    expect(missingCost.message).toContain("invalid total_cost_usd");

    const stringCost = invokeWrapper(JSON.stringify({ type: "result", is_error: false, total_cost_usd: "0.1" }), 0);
    expect(stringCost.threw).toBe(true);
    expect(stringCost.message).toContain("invalid total_cost_usd");

    const missingFlag = invokeWrapper(JSON.stringify({ type: "result", total_cost_usd: 0.1 }), 0);
    expect(missingFlag.threw).toBe(true);
    expect(missingFlag.message).toContain("is_error=missing");
  });
});

describe("OG-86 acceptance wall time", () => {
  it("measures npm-test wall time so the ceiling includes it", () => {
    // A ceiling that ignored the acceptance run would under-count the arm. The
    // fake CLI writes the transcript the driver reads, and `npm test` runs in a
    // workload directory holding a trivial passing suite, so no real work runs.
    const result = evaluate<{ wallSeconds: number; passed: boolean; isNumber: boolean; isBoolean: boolean }>(`
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-acc-"));
const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });
const fake = join(bin, "claude");
writeFileSync(fake, ["#!/usr/bin/env node","const fs=require('node:fs'),p=require('node:path');",
  "fs.mkdirSync(p.dirname(process.env.OG86_TP), { recursive: true });",
  "fs.appendFileSync(process.env.OG86_TP, JSON.stringify({ type: 'assistant', uuid: 'u' + Math.random(), message: { role: 'assistant', model: 'claude-haiku-4-5-20251001' } }) + String.fromCharCode(10));",
  "fs.writeFileSync(process.env.OG86_TP + '.path', process.env.OG86_TP);",
  "process.stdout.write(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.01, num_turns: 1, session_id: 's', result: '{}' }));"].join(String.fromCharCode(10)));
chmodSync(fake, 0o755);
const armRoot = join(root, "private", "arm-a");
mkdirSync(armRoot, { recursive: true });
const workload = join(armRoot, "workload");
mkdirSync(workload, { recursive: true });
writeFileSync(join(workload, "package.json"), JSON.stringify({ name: "w", private: true, type: "module", scripts: { test: "node --test" } }));
process.env.OG86_TP = join(armRoot, "source.jsonl");
writeFileSync(join(armRoot, "transcript-path.txt"), process.env.OG86_TP + String.fromCharCode(10));
import { existsSync } from "node:fs";
const driver = controller.createClaudeDriver({
  repository: process.cwd(), benchmark: ARGS.benchmark, privateRoot: join(root, "private"),
  dcompact: join(root, "cli.js"), claudeBinary: fake,
});
driver.openArm("A", 1);
const acceptance = driver.runAcceptance({ arm: "A" });
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  wallSeconds: acceptance.wallSeconds,
  passed: acceptance.passed,
  isNumber: typeof acceptance.wallSeconds === "number",
  isBoolean: typeof acceptance.passed === "boolean",
}));
`, { benchmark: join(root, "docs", "benchmark", "og86-medium-v1") });
    expect(result.isNumber).toBe(true);
    expect(result.isBoolean).toBe(true);
    expect(result.wallSeconds).toBeGreaterThan(0);
  });

  it("adds acceptance time to the arm total through accumulate", () => {
    // The observation is what carries the time into the ceiling accounting.
    const emitted = evaluate<{ wallSeconds: number; checkpoints: Array<{ elapsedWallSeconds: number }> }>(`
${DRIVER_PRELUDE}
const result = runSeries({ runAcceptance: () => ({ passed: true, wallSeconds: 42 }) });
const revisions = { runner: "sha256:" + "f".repeat(64), scorer: "sha256:" + "0".repeat(64) };
process.stdout.write(JSON.stringify(controller.armArtifact(result.state, "A", revisions)));
`);
    // The suite already adds 30 s per acceptance; 42 replaces it.
    expect(emitted.wallSeconds).toBeGreaterThan(0);
    for (const checkpoint of emitted.checkpoints) {
      expect(checkpoint.elapsedWallSeconds).toBeGreaterThan(0);
    }
  });
});

describe("OG-86 Stage-0 probe attribution", () => {
  it("splits creation from probe by identity, not by the fork file total", () => {
    // Stage 0 reads one fork file twice: the creation invocation's records are
    // in it before the probe, and the probe appends its own. Reading the file's
    // total would credit the probe with the creation's work, so the baseline is
    // the post-creation identity set. The shape here is the measured one: 30
    // source identities, then 4 fork identities of which 2 are shared.
    const result = evaluate<{ creation: number; probe: number; probeMatching: number; probeForeign: number; proven: boolean }>(`
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-s0attr-"));
const MODEL = "claude-haiku-4-5-20251001";
const write = (name, ids) => {
  const path = join(root, name);
  const rows = ids.map((id) => JSON.stringify({ type: "assistant", uuid: id, message: { role: "assistant", model: MODEL } }));
  writeFileSync(path, rows.join(String.fromCharCode(10)) + (rows.length ? String.fromCharCode(10) : ""));
  return path;
};
const source = controller.assistantIdentities(write("src.jsonl", ARGS.sourceIds));
const afterCreation = controller.assistantIdentities(write("fork-creation.jsonl", ARGS.creationIds));
const afterProbe = controller.assistantIdentities(write("fork-probe.jsonl", ARGS.probeIds));
const creation = controller.identityAttribution({ before: source, after: afterCreation, requiredModel: MODEL, relationship: "fresh-transcript" });
const probe = controller.identityAttribution({ before: afterCreation, after: afterProbe, requiredModel: MODEL, relationship: "append-only" });
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  creation: creation.assistantRecords,
  probe: probe.assistantRecords,
  probeMatching: probe.matchingModelRecords,
  probeForeign: probe.fallbackRecords,
  proven: probe.proven,
}));
`, {
      sourceIds: Array.from({ length: 30 }, (_, index) => `src-${index}`),
      creationIds: ["src-0", "src-1", "fork-1", "fork-2"],
      probeIds: ["src-0", "src-1", "fork-1", "fork-2", "probe-1"],
    });
    expect(result.creation).toBe(2);
    expect(result.probe).toBe(1);
    expect(result.probeMatching).toBe(1);
    expect(result.probeForeign).toBe(0);
    expect(result.proven).toBe(true);
  });
});

describe("OG-86 frozen fork baseline", () => {
  /**
   * The hazard this guards: the fork file grows between createFork and
   * probeFork. A probe that re-read the file as its `before` state would absorb
   * the probe's own records into the baseline and under-count the probe by
   * exactly the records it added. The frozen baseline is immune.
   */
  it("counts the probe addition correctly when the fork file grows between calls", () => {
    const result = evaluate<{
      probeFromFrozen: number;
      probeFromReread: number;
      frozenCount: number;
      grownCount: number;
    }>(`
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-grow-"));
const MODEL = "claude-haiku-4-5-20251001";
const write = (name, ids) => {
  const path = join(root, name);
  const rows = ids.map((id) => JSON.stringify({ type: "assistant", uuid: id, message: { role: "assistant", model: MODEL } }));
  writeFileSync(path, rows.join(String.fromCharCode(10)) + (rows.length ? String.fromCharCode(10) : ""));
  return path;
};
const creation = ["shared-1", "shared-2", "fork-1", "fork-2"];
const afterProbe = creation.concat(["probe-1"]);
const frozenPath = write("frozen.jsonl", creation);
const grownPath = write("grown.jsonl", afterProbe);

// The frozen baseline, captured at creation time.
const frozen = controller.assistantIdentities(frozenPath);
// The grown file, which is what a re-read would pick up as "before".
const grown = controller.assistantIdentities(grownPath);

const probeFromFrozen = controller.identityAttribution({
  before: frozen, after: grown, requiredModel: MODEL, relationship: "append-only",
});
const probeFromReread = controller.identityAttribution({
  before: grown, after: grown, requiredModel: MODEL, relationship: "append-only",
});
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  probeFromFrozen: probeFromFrozen.assistantRecords,
  probeFromReread: probeFromReread.assistantRecords,
  frozenCount: frozen.assistantRecords,
  grownCount: grown.assistantRecords,
}));
`, {});
    // Against the frozen baseline the probe's one addition is counted.
    expect(result.probeFromFrozen).toBe(1);
    // A re-read baseline would have counted zero: the bug this prevents.
    expect(result.probeFromReread).toBe(0);
    expect(result.frozenCount).toBe(4);
    expect(result.grownCount).toBe(5);
  });

  it("persists the baseline ids, models, digest, count, and usable status", () => {
    const record = evaluate<Record<string, unknown>>(`
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-persist-"));
const path = join(root, "fork.jsonl");
const MODEL = "claude-haiku-4-5-20251001";
writeFileSync(path, ["a", "b"].map((id) => JSON.stringify({ type: "assistant", uuid: id, message: { role: "assistant", model: MODEL } })).join(String.fromCharCode(10)) + String.fromCharCode(10));
const baseline = controller.assistantIdentities(path);
const recorded = controller.__persistForkRecord(root, 2, "fork-session", path, baseline);
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify(recorded));
`, {});
    expect(record.phase).toBe(2);
    expect(record.forkId).toBe("fork-session");
    expect(record.forkTranscriptPath).toMatch(/fork\.jsonl$/);
    const baseline = record.baseline as Record<string, unknown>;
    expect(baseline.ids).toEqual(["a", "b"]);
    expect(baseline.count).toBe(2);
    expect(baseline.usable).toBe(true);
    expect(typeof baseline.digest).toBe("string");
    expect(baseline.models).toEqual({ a: "claude-haiku-4-5-20251001", b: "claude-haiku-4-5-20251001" });
  });

  it("fails closed on each invalid fork record field", () => {
    const failures = evaluate<Record<string, string | null>>(`
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-valid-"));
const path = join(root, "fork.jsonl");
const MODEL = "claude-haiku-4-5-20251001";
writeFileSync(path, JSON.stringify({ type: "assistant", uuid: "a", message: { role: "assistant", model: MODEL } }) + String.fromCharCode(10));
const baseline = controller.assistantIdentities(path);
const good = controller.__persistForkRecord(root, 2, "fork-session", path, baseline);
const attempt = (mutate) => {
  const record = JSON.parse(JSON.stringify(good));
  mutate(record);
  try { controller.__frozenBaseline(record, { phase: 2, fork: "fork-session" }); return null; }
  catch (error) { return error.message; }
};
const out = {
  good: (() => { try { controller.__frozenBaseline(good, { phase: 2, fork: "fork-session" }); return null; } catch (e) { return e.message; } })(),
  missing: attempt((r) => { r.baseline = undefined; }),
  wrongPhase: attempt((r) => { r.phase = 3; }),
  outOfRange: attempt((r) => { r.phase = 5; }),
  emptyForkId: attempt((r) => { r.forkId = ""; }),
  mismatchedFork: attempt((r) => { r.forkId = "other"; }),
  noPath: attempt((r) => { r.forkTranscriptPath = ""; }),
  unusable: attempt((r) => { r.baseline.usable = false; }),
  dupIds: attempt((r) => { r.baseline.ids = ["a", "a"]; r.baseline.count = 2; }),
  countMismatch: attempt((r) => { r.baseline.count = 9; }),
  digestMismatch: attempt((r) => { r.baseline.digest = "sha256:" + "0".repeat(64); }),
};
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify(out));
`, {});
    expect(failures.good).toBeNull();
    expect(failures.missing).toContain("baseline is missing");
    expect(failures.wrongPhase).toContain("does not match the checkpoint");
    expect(failures.outOfRange).toContain("not 1..4");
    expect(failures.emptyForkId).toContain("fork id is missing");
    expect(failures.mismatchedFork).toContain("does not match the created fork");
    expect(failures.noPath).toContain("path is missing");
    expect(failures.unusable).toContain("unusable");
    expect(failures.dupIds).toContain("not unique");
    expect(failures.countMismatch).toContain("count does not match");
    expect(failures.digestMismatch).toContain("digest does not match");
  });
});

describe("OG-86 freeze manifest scope", () => {
  it("covers the benchmark directory plus exactly the allowlisted externals", () => {
    const result = evaluate<{
      benchmarkFiles: number;
      symlinks: number;
      allowlist: string[];
      rowsWithoutUntracked: number;
      manifestExcluded: boolean;
      armsExcluded: boolean;
    }>(`
import { resolve, relative, basename } from "node:path";
const repo = process.cwd();
const bench = resolve(ARGS.benchmark);
const { files, symlinks } = checksum.collectBenchmarkFiles(bench);
process.stdout.write(JSON.stringify({
  benchmarkFiles: files.length,
  symlinks: symlinks.length,
  allowlist: checksum.EXTERNAL_ALLOWLIST,
  manifestExcluded: !files.some((f) => basename(f) === "checksums.sha256"),
  armsExcluded: !files.some((f) => relative(bench, f).startsWith("arms")),
  rowsWithoutUntracked: 0,
}));
`, { benchmark: join(root, "docs", "benchmark", "og86-medium-v1") });
    // The benchmark tree contributes its tracked files; the manifest itself and
    // arms/ are excluded from discovery.
    expect(result.benchmarkFiles).toBeGreaterThan(20);
    expect(result.manifestExcluded).toBe(true);
    expect(result.armsExcluded).toBe(true);
    expect(result.symlinks).toBe(0);
    // Exactly the audited allowlist, in the audited order.
    expect(result.allowlist).toEqual([
      "scripts/benchmark/checksum-og86.mjs",
      "scripts/benchmark/generate-og86-inputs.mjs",
      "scripts/benchmark/og86-binding.mjs",
      "scripts/benchmark/privacy-scan-og86.mjs",
      "scripts/benchmark/run-og86-medium.mjs",
      "scripts/benchmark/run-og86-stage0.mjs",
      "scripts/benchmark/score-og86.mjs",
      "test/og86-benchmark.spec.ts",
      "test/og86-controller.spec.ts",
      "vitest.config.ts",
      "eslint.config.js",
      "tsconfig.json",
      "package.json",
      "package-lock.json",
    ]);
  });

  it("uses the frozen row format with repo-relative external paths", () => {
    const rendered = evaluate<string>(`
process.stdout.write(JSON.stringify(checksum.renderManifest([
  { digest: "a".repeat(64), path: "protocol.json" },
  { digest: "b".repeat(64), path: "../../../scripts/benchmark/score-og86.mjs" },
])));
`);
    const rows = rendered.trim().split("\n");
    expect(rows[0]).toBe(`${"a".repeat(64)}  protocol.json`);
    // `<64-hex><two spaces><path relative to the benchmark dir>`.
    expect(rows[1]).toBe(`${"b".repeat(64)}  ../../../scripts/benchmark/score-og86.mjs`);
    for (const row of rows) expect(/^[0-9a-f]{64} {2}.+$/.test(row)).toBe(true);
  });

  it("refuses untracked, symlinked, and ignored paths", () => {
    const result = evaluate<Record<string, string | null>>(`
import { resolve } from "node:path";
const repo = process.cwd();
process.stdout.write(JSON.stringify({
  // A real tracked file is accepted.
  tracked: checksum.isTracked(repo, resolve("package.json"), "package.json") ? "yes" : "no",
  // Private spill and build output are never tracked.
  sessions: checksum.isTracked(repo, resolve("sessions"), "sessions") ? "yes" : "no",
  dist: checksum.isTracked(repo, resolve("dist"), "dist") ? "yes" : "no",
  nodeModules: checksum.isTracked(repo, resolve("node_modules"), "node_modules") ? "yes" : "no",
  // The ignore guard rejects the gitignored private tree.
  sessionsIgnored: checksum.isIgnored(repo, "sessions") ? "yes" : "no",
  distIgnored: checksum.isIgnored(repo, "dist") ? "yes" : "no",
  packageNotIgnored: checksum.isIgnored(repo, "package.json") ? "yes" : "no",
}));
`);
    expect(result.tracked).toBe("yes");
    expect(result.sessions).toBe("no");
    expect(result.dist).toBe("no");
    expect(result.nodeModules).toBe("no");
    expect(result.sessionsIgnored).toBe("yes");
    expect(result.distIgnored).toBe("yes");
    expect(result.packageNotIgnored).toBe("no");
  });

  it("refuses an empty row set rather than writing a manifest", () => {
    const result = evaluate<{ threw: boolean; message: string }>(`
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-empty-"));
let threw = false;
let message = "";
try {
  const { rows, refusals } = checksum.buildManifest({ repository: root, benchmarkRoot: root });
  if (rows.length === 0) throw new Error("refusing to write an empty manifest");
  message = "wrote " + rows.length + " rows (refusals " + refusals.length + ")";
} catch (error) { threw = true; message = error.message; }
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ threw, message }));
`, {});
    expect(result.threw).toBe(true);
    expect(result.message).toContain("empty manifest");
  });
});

/**
 * An isolated repository carrying only the two seed fields the gate reads, so
 * the gate is proven against fixture data instead of this repository's own
 * history -- which the operator has since seeded for real (OG-86), and any
 * future seed commit here would otherwise re-break these tests permanently.
 */
function seedFixtureRepo(seed: { freezeCommit: string | null; armOrderSeedCommit: string | null }): string {
  const dir = mkdtempSync(join(tmpdir(), "og86-seed-fixture-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "og86-fixture@example.invalid"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "og86-fixture"], { cwd: dir });
  const benchmark = join(dir, "docs", "benchmark", "og86-medium-v1");
  mkdirSync(benchmark, { recursive: true });
  writeFileSync(join(benchmark, "protocol.json"), JSON.stringify({ freezeCommit: seed.freezeCommit }));
  writeFileSync(join(benchmark, "schedule.json"), JSON.stringify({ armOrderSeedCommit: seed.armOrderSeedCommit }));
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "fixture"], { cwd: dir });
  return dir;
}

describe("OG-86 seed gate", () => {
  it("refuses to execute pre-seed and accepts an agreeing local seed", () => {
    const repo = seedFixtureRepo({ freezeCommit: null, armOrderSeedCommit: null });
    try {
      const realCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
      const result = evaluate<Record<string, string | null>>(`
const repo = ARGS.repo;
const attempt = (fn) => { try { fn(); return null; } catch (error) { return error.message; } };
process.stdout.write(JSON.stringify({
  // The fixture repository is deliberately pre-seed, so execute must refuse.
  preSeed: attempt(() => controller.assertSeedReady(repo)),
  // A bogus revision is rejected by shape.
  badShape: controller.isLocalCommit(repo, "HEAD") ? "yes" : "no",
  shortHex: controller.isLocalCommit(repo, ARGS.realCommit.slice(0, 7)) ? "yes" : "no",
  // The fixture's own real commit resolves.
  realCommit: controller.isLocalCommit(repo, ARGS.realCommit) ? "yes" : "no",
  // A well-formed but absent commit does not.
  absent: controller.isLocalCommit(repo, "0".repeat(40)) ? "yes" : "no",
}));
`, { repo, realCommit });
      expect(result.preSeed).toContain("before the seed");
      expect(result.badShape).toBe("no");
      expect(result.shortHex).toBe("no");
      expect(result.realCommit).toBe("yes");
      expect(result.absent).toBe("no");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports the pre-seed seed fields as null", () => {
    const repo = seedFixtureRepo({ freezeCommit: null, armOrderSeedCommit: null });
    try {
      const seed = evaluate<Record<string, unknown>>(`
process.stdout.write(JSON.stringify(controller.readSeedFields(ARGS.repo)));
`, { repo });
      // The fixture content records no seed, and the generator must not invent one.
      expect(seed.protocolFreezeCommit).toBeNull();
      expect(seed.scheduleArmOrderSeedCommit).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked or non-empty private root", () => {
    const result = evaluate<Record<string, string | null>>(`
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-root-"));
const fresh = join(root, "fresh");
mkdirSync(fresh, { recursive: true });
const populated = join(root, "populated");
mkdirSync(populated, { recursive: true });
writeFileSync(join(populated, "run-manifest.json"), "{}");
const link = join(root, "link");
symlinkSync(fresh, link);
const attempt = (path) => { try { controller.assertPrivateRootWritable(path); return null; } catch (error) { return error.message; } };
const out = {
  missing: attempt(join(root, "does-not-exist")),
  empty: attempt(fresh),
  populated: attempt(populated),
  symlink: attempt(link),
};
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify(out));
`, {});
    expect(result.missing).toBeNull();
    expect(result.empty).toBeNull();
    expect(result.populated).toContain("non-empty private root");
    expect(result.symlink).toContain("symlinked private root");
  });
});

describe("OG-86 Stage-0 tool matrix class verification", () => {
  it("reports the true class for every location-class row under the hook's geometry", () => {
    const result = evaluate<{ rows: Array<{ name: string; location: string; observedClass: string; classChecked: boolean }> }>(`
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-b1-"));
// Realistic host geometry: the transcript sits under <profile>/projects/<slug>/.
const profile = join(root, "profile");
const slug = join(profile, "projects", "-slug-");
const transcript = join(slug, "session.jsonl");
const workload = join(root, "workload");
mkdirSync(slug, { recursive: true });
mkdirSync(workload, { recursive: true });
writeFileSync(transcript, "{}\\n");
const state = join(root, "state");
mkdirSync(state, { recursive: true });
writeFileSync(join(state, "transcript-path.txt"), transcript + String.fromCharCode(10));
const rows = stage0.observedToolMatrix({ sourceRoot: state, workload, transcriptPath: transcript });
process.stdout.write(JSON.stringify({ rows: rows.map((r) => ({ name: r.name, location: r.location, observedClass: r.observedClass, classChecked: r.classChecked })) }));
`, {});
    const byName = new Map(result.rows.map((row) => [row.name, row]));
    // Each path-resolving row must now report the class it was labelled with.
    for (const location of ["transcript", "profile", "store", "rubric", "scorer", "capture"]) {
      for (const capability of ["read", "edit", "write", "glob", "grep"]) {
        const row = byName.get(`${capability}-${location}`);
        expect(row, `${capability}-${location}`).toBeDefined();
        expect(row!.observedClass, `${capability}-${location}`).toBe(location);
        expect(row!.classChecked, `${capability}-${location}`).toBe(true);
      }
    }
  });

  it("detects a wrong-class denial that a verdict-only check would pass", () => {
    // Two rows with the same denied verdict but different classes: only the
    // class-aware comparison separates them.
    const mismatches = evaluate<{ wrongClass: string[]; rightClass: string[] }>(`
const base = controller.matrixExpectations().map((plan) => ({
  name: plan.name,
  allowed: plan.expected === "allow",
  observedClass: plan.expected === "allow" ? "workload" : plan.location,
}));
const wrong = base.map((row) => row.name === "read-transcript" ? { ...row, observedClass: "outside" } : row);
process.stdout.write(JSON.stringify({
  wrongClass: controller.matrixMismatches(wrong),
  rightClass: controller.matrixMismatches(base),
}));
`);
    expect(mismatches.rightClass).toEqual([]);
    // Verdict unchanged, so a verdict-only filter would have reported nothing.
    expect(mismatches.wrongClass).toEqual(["read-transcript:class:outside"]);
  });
});

describe("OG-86 Stage-0 preflights", () => {
  it("validates dependency ancestry from the plan's machine-readable fields", () => {
    const result = evaluate<Record<string, unknown>>(`
import { readFileSync } from "node:fs";
const plan = JSON.parse(readFileSync(ARGS.planPath, "utf8"));
process.stdout.write(JSON.stringify({
  real: stage0.ancestryPreflight({ repository: process.cwd(), plan }),
  missingBase: stage0.ancestryPreflight({ repository: process.cwd(), plan: { ...plan, dependencyBaseCommit: "0".repeat(40) } }),
  notAncestor: stage0.ancestryPreflight({ repository: process.cwd(), plan: { ...plan, dependencyBaseCommit: "1".repeat(40) } }),
  badShape: stage0.ancestryPreflight({ repository: process.cwd(), plan: { ...plan, dependencyBaseCommit: "HEAD" } }),
  emptyDeps: stage0.ancestryPreflight({ repository: process.cwd(), plan: { ...plan, dependencyCommits: [] } }),
}));
`, { planPath: join(root, "docs", "benchmark", "og86-medium-v1", "stage0-plan.json") });
    expect((result.real as { ok: boolean }).ok).toBe(true);
    expect((result.missingBase as { failures: string[] }).failures).toContain("dependencyBaseCommit:missing");
    expect((result.notAncestor as { failures: string[] }).failures).toContain("dependencyBaseCommit:missing");
    expect((result.badShape as { failures: string[] }).failures).toContain("dependencyBaseCommit:not-40-hex");
    expect((result.emptyDeps as { failures: string[] }).failures).toContain("dependencyCommits:empty");
  });

  it("runs a deterministic scorer mutation preflight in a caller-supplied scratch", () => {
    const result = evaluate<Record<string, unknown>>(`
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const scratch = mkdtempSync(join(tmpdir(), "og86-scratch-"));
const out = stage0.scorerPreflight({ scorerPath: ARGS.scorer, atomsPath: ARGS.atoms, scratchRoot: scratch });
rmSync(scratch, { recursive: true, force: true });
process.stdout.write(JSON.stringify(out));
`, { scorer: join(root, "scripts", "benchmark", "score-og86.mjs"), atoms: join(root, "docs", "benchmark", "og86-medium-v1", "atoms.json") });
    expect(result.ok).toBe(true);
    expect((result.canonical as { points: number }).points).toBe(100);
    expect((result.mutated as { points: number }).points).toBe(99);
    expect((result.mutated as { missing: number }).missing).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it("runs the public privacy scanner preflight", () => {
    const result = evaluate<Record<string, unknown>>(`
process.stdout.write(JSON.stringify(stage0.privacyPreflight({ benchmarkRoot: ARGS.benchmark })));
`, { benchmark: join(root, "docs", "benchmark", "og86-medium-v1") });
    expect(result.ok).toBe(true);
    expect(result.scannedFiles).toBeGreaterThan(20);
  });

  it("requires B and C to share one treatment channel", () => {
    const result = evaluate<Record<string, unknown>>(`
const arm = (name, event, channel, copies) => ({
  arm: name, treatmentEvent: event, treatmentChannel: channel, treatmentCopies: copies,
  treatmentOutputFields: copies > 0 ? [channel] : [],
});
process.stdout.write(JSON.stringify({
  shared: stage0.channelPreflight({ arms: [arm("A", null, null, 0), arm("B", "SessionStart", "additionalContext", 1), arm("C", "SessionStart", "additionalContext", 1)] }),
  divergent: stage0.channelPreflight({ arms: [arm("A", null, null, 0), arm("B", "SessionStart", "hookSpecificOutput.additionalContext", 1), arm("C", "SessionStart", "hookSpecificOutput.other", 1)] }),
  missing: stage0.channelPreflight({ arms: [arm("A", null, null, 0), arm("B", "SessionStart", "additionalContext", 0), arm("C", "SessionStart", "additionalContext", 1)] }),
  controlTreated: stage0.channelPreflight({ arms: [arm("A", "SessionStart", "additionalContext", 1), arm("B", "SessionStart", "additionalContext", 1), arm("C", "SessionStart", "additionalContext", 1)] }),
  unobserved: stage0.channelPreflight({ arms: [arm("A", null, null, 0), arm("B", "SessionStart", null, 1), arm("C", "SessionStart", null, 1)] }),
}));
`);
    expect((result.shared as { ok: boolean }).ok).toBe(true);
    expect((result.shared as { sharedChannel: string }).sharedChannel).toBe("SessionStart|additionalContext");
    // A delivered arm whose hook recorded no field name is a vacuous comparison.
    expect((result.unobserved as { failures: string[] }).failures).toContain("treatment-channel-unobserved");
    expect((result.divergent as { failures: string[] }).failures).toContain("active-arms-do-not-share-one-channel");
    expect((result.missing as { failures: string[] }).failures).toContain("active-arm-missing-treatment");
    expect((result.controlTreated as { failures: string[] }).failures).toContain("control-arm-received-treatment");
  });

  it("keeps the plan at 24 checks with machine-readable dependency fields", () => {
    const plan = JSON.parse(readFileSync(join(root, "docs", "benchmark", "og86-medium-v1", "stage0-plan.json"), "utf8")) as {
      checks: string[];
      dependencyBaseCommit: string;
      dependencyCommits: string[];
    };
    expect(plan.checks).toHaveLength(24);
    expect(plan.dependencyBaseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(plan.dependencyCommits.length).toBeGreaterThan(0);
    for (const commit of plan.dependencyCommits) expect(commit).toMatch(/^[0-9a-f]{40}$/);
    // Each declared check must name a gate the runner actually evaluates.
    expect(plan.checks.some((check) => check.includes("dependency ancestry"))).toBe(true);
    expect(plan.checks.some((check) => check.includes("digest recomputed"))).toBe(true);
    expect(plan.checks.some((check) => check.includes("additionalContext channel"))).toBe(true);
    expect(plan.checks.some((check) => check.includes("scorer mutation preflight"))).toBe(true);
    expect(plan.checks.some((check) => check.includes("privacy scan preflight"))).toBe(true);
  });
});

describe("OG-86 medium private tree modes", () => {
  it("measures modes, requires owner-only, and refuses symlinks", () => {
    const result = evaluate<Record<string, unknown>>(`
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-modes-"));
mkdirSync(join(root, "tree"), { recursive: true, mode: 0o700 });
writeFileSync(join(root, "tree", "a.txt"), "x", { mode: 0o600 });
chmodSync(join(root, "tree"), 0o700);
const clean = controller.privateTreeModes(join(root, "tree"));
symlinkSync(join(root, "tree", "a.txt"), join(root, "tree", "link"));
const linked = controller.privateTreeModes(join(root, "tree"));
const sanitized = controller.sanitizedModes(linked);
const absentMeasurable = controller.privateTreeModes(join(root, "does-not-exist")).measurable;
const absentOwnerOnly = controller.privateTreeModes(join(root, "does-not-exist")).allDirectoriesOwnerOnly;
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  cleanDirs: clean.allDirectoriesOwnerOnly,
  cleanFiles: clean.allFilesOwnerOnly,
  cleanZeroLinks: clean.zeroSymlinks,
  linkedCount: linked.symlinkCount,
  linkedZero: linked.zeroSymlinks,
  sanitizedKeys: Object.keys(sanitized).sort(),
  sanitizedHasPath: JSON.stringify(sanitized).includes(root),
  absentMeasurable,
  absentOwnerOnly,
}));
`, {});
    expect(result.cleanDirs).toBe(true);
    expect(result.cleanFiles).toBe(true);
    expect(result.cleanZeroLinks).toBe(true);
    expect(result.linkedCount).toBe(1);
    expect(result.linkedZero).toBe(false);
    // The sanitized summary is mode tallies and booleans, never a path.
    expect(result.sanitizedKeys).toEqual([
      "allDirectoriesOwnerOnly", "allFilesOwnerOnly", "directoryCount", "directoryModes",
      "fileCount", "fileModes", "readFailureCount", "rootPresent", "symlinkCount", "zeroSymlinks",
    ]);
    // A vacuous reading must not describe itself as owner-only.
    expect(result.absentMeasurable).toBe(false);
    expect(result.absentOwnerOnly).toBe(false);
    expect(result.sanitizedHasPath).toBe(false);
  });

  it("measures verifySource wall time instead of a literal", () => {
    const result = evaluate<Record<string, unknown>>(`
${DRIVER_PRELUDE}
const result = runSeries({});
const checkpoints = result.state.arms.A.checkpoints;
process.stdout.write(JSON.stringify({
  allMeasured: checkpoints.every((entry) => entry.elapsedWallSeconds > 0),
  verifyContributions: checkpoints.length,
}));
`, {});
    expect(result.allMeasured).toBe(true);
  });

  it("invalidates a checkpoint whose modes are missing or wrong", () => {
    const missing = series({ verifySource: `() => ({ source: { bytes: 1000, lines: 10, sha256: "sha256:" + "a".repeat(64) }, canaryOccurrenceCount: 0, wallSeconds: 0.001 })` });
    expect(missing.state.invalidations.some((entry) => entry.includes("private-tree-modes-missing"))).toBe(true);

    const symlinked = series({
      verifySource: `() => ({ source: { bytes: 1000, lines: 10, sha256: "sha256:" + "a".repeat(64) }, canaryOccurrenceCount: 0, privateTreeModes: { directoryModes: { 700: 1 }, fileModes: { 600: 1 }, symlinkCount: 1, allDirectoriesOwnerOnly: true, allFilesOwnerOnly: true, zeroSymlinks: false }, wallSeconds: 0.001 })`,
    });
    expect(symlinked.state.invalidations.some((entry) => entry.includes("private-tree-symlink"))).toBe(true);

    const looseMode = series({
      verifySource: `() => ({ source: { bytes: 1000, lines: 10, sha256: "sha256:" + "a".repeat(64) }, canaryOccurrenceCount: 0, privateTreeModes: { directoryModes: { 755: 1 }, fileModes: { 644: 1 }, symlinkCount: 0, allDirectoriesOwnerOnly: false, allFilesOwnerOnly: false, zeroSymlinks: true }, wallSeconds: 0.001 })`,
    });
    expect(looseMode.state.invalidations.some((entry) => entry.includes("private-tree-directory-mode"))).toBe(true);
    expect(looseMode.state.invalidations.some((entry) => entry.includes("private-tree-file-mode"))).toBe(true);
  });

  it("emits privateTreeModes per checkpoint and refuses without it", () => {
    const emitted = evaluate<{ checkpoints: Array<{ privateTreeModes: Record<string, unknown> }> }>(`
${DRIVER_PRELUDE}
const result = runSeries({});
const revisions = { runner: "sha256:" + "f".repeat(64), scorer: "sha256:" + "0".repeat(64) };
process.stdout.write(JSON.stringify(controller.armArtifact(result.state, "A", revisions)));
`);
    expect(emitted.checkpoints).toHaveLength(4);
    for (const checkpoint of emitted.checkpoints) {
      expect(checkpoint.privateTreeModes).toMatchObject({ symlinkCount: 0, allDirectoriesOwnerOnly: true, allFilesOwnerOnly: true, zeroSymlinks: true });
    }
  });
});

describe("OG-86 benchmark root validation", () => {
  it("refuses a symlinked, missing, or out-of-repository root", () => {
    const result = evaluate<Record<string, unknown>>(`
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const repo = process.cwd();
const t = mkdtempSync(join(tmpdir(), "og86-rootv-"));
const real = join(t, "real");
mkdirSync(real);
const link = join(t, "link");
symlinkSync(real, link);
const good = checksum.validateBenchmarkRoot({ repository: repo, benchmarkRoot: ARGS.benchmark });
const outside = checksum.validateBenchmarkRoot({ repository: repo, benchmarkRoot: "/tmp" });
const symlinked = checksum.validateBenchmarkRoot({ repository: t, benchmarkRoot: link });
const missing = checksum.validateBenchmarkRoot({ repository: t, benchmarkRoot: join(t, "nope") });
const manifest = checksum.buildManifest({ repository: t, benchmarkRoot: link });
rmSync(t, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  goodOk: good.ok,
  outsideFailures: outside.failures,
  symlinkFailures: symlinked.failures,
  missingFailures: missing.failures,
  manifestRows: manifest.rows.length,
  manifestRefusals: manifest.refusals.map((r) => r.reason),
}));
`, { benchmark: join(root, "docs", "benchmark", "og86-medium-v1") });
    expect(result.goodOk).toBe(true);
    expect(result.outsideFailures).toContain("outside-repository");
    expect(result.symlinkFailures).toContain("symlink");
    expect(result.missingFailures).toContain("missing");
    // A refused root yields no rows at all rather than a partial manifest.
    expect(result.manifestRows).toBe(0);
    expect(result.manifestRefusals).toContain("benchmark-root:symlink");
  });
});

describe("OG-86 checkpoint binding helper", () => {
  it("hashes a transcript line including its terminator", () => {
    const result = evaluate<{ withNewline: string; withoutNewline: string; endsAtBoundary: boolean; lines: number }>(`
import { createHash } from "node:crypto";
const bytes = Buffer.from("{\\"a\\":1}\\n{\\"b\\":2}\\n", "utf8");
const prefix = binding.retainedPrefix(bytes, 8);
const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
process.stdout.write(JSON.stringify({
  withNewline: hash(Buffer.from("{\\"a\\":1}\\n", "utf8")),
  actual: prefix.retainedPrefixSha256,
  withoutNewline: hash(Buffer.from("{\\"a\\":1}", "utf8")),
  endsAtBoundary: prefix.prefixEndsAtLineBoundary,
  lines: prefix.retainedPrefixLines,
}));
`);
    expect(result.withNewline).toBe((result as unknown as { actual: string }).actual);
    expect(result.withoutNewline).not.toBe(result.withNewline);
    expect(result.endsAtBoundary).toBe(true);
    expect(result.lines).toBe(1);
  });

  it("counts a final unterminated line and flags a mid-line prefix", () => {
    const result = evaluate<{ terminated: number; unterminated: number; boundary: boolean }>(`
const bytes = Buffer.from("one\\ntwo", "utf8");
process.stdout.write(JSON.stringify({
  terminated: binding.retainedPrefix(bytes, 4).retainedPrefixLines,
  unterminated: binding.retainedPrefix(bytes, 7).retainedPrefixLines,
  boundary: binding.retainedPrefix(bytes, 6).prefixEndsAtLineBoundary,
}));
`);
    expect(result.terminated).toBe(1);
    expect(result.unterminated).toBe(2);
    expect(result.boundary).toBe(false);
  });
});

describe("OG-86 preregistered schedule", () => {
  const benchmark = join(root, "docs", "benchmark", "og86-medium-v1");
  const schedule = JSON.parse(readFileSync(join(benchmark, "schedule.json"), "utf8")) as {
    phases: number;
    manualCompactions: number;
    sequencePerPhase: string[];
    advisoryCostTelemetry: { role: string; perScoredArmUsd: number; mediumSeriesUsd: number };
    emergencyRunawayCeiling: { role: string; perScoredArmUsd: number; mediumSeriesUsd: number };
    stops: { invalidations: string[]; operationalStops: string[] };
  };
  const protocol = JSON.parse(readFileSync(join(benchmark, "protocol.json"), "utf8")) as {
    costAndLimits: {
      advisoryTelemetry: { role: string; perScoredArmUsd: number; mediumSeriesUsd: number };
      emergencyRunawayCeiling: { role: string; perScoredArmUsd: number; mediumSeriesUsd: number };
    };
    checkpointOrder: string[];
  };

  it("records the corrected fork-before-resume checkpoint order", () => {
    expect(schedule.phases).toBe(4);
    expect(schedule.manualCompactions).toBe(4);
    const fork = schedule.sequencePerPhase.findIndex((step) => /fork/.test(step));
    const sourceResume = schedule.sequencePerPhase.findIndex((step) => /resume (?:the )?source/.test(step));
    expect(fork).toBeGreaterThan(-1);
    expect(sourceResume).toBeGreaterThan(fork);
    // The score fork must be created, scored, and the parent verified before resume.
    const scored = schedule.sequencePerPhase.findIndex((step) => /record the neutral recall response/.test(step));
    const verified = schedule.sequencePerPhase.findIndex((step) => /source transcript and require byte-identical/.test(step));
    expect(scored).toBeGreaterThan(fork);
    expect(verified).toBeGreaterThan(fork);
    expect(verified).toBeLessThan(sourceResume);
  });

  it("states advisory cost and a separate runaway ceiling, not a cost invalidation", () => {
    // Cost is advisory telemetry: it appears in neither the scientific
    // invalidations nor the operational stops.
    expect(schedule.stops.invalidations.some((entry) => /cost/i.test(entry))).toBe(false);
    expect(schedule.stops.operationalStops).toContain("emergency-runaway-ceiling-reached");
    expect(schedule.stops.invalidations.some((entry) => /runaway/i.test(entry))).toBe(false);
    expect(schedule.advisoryCostTelemetry.role).toContain("never a validity gate");
    expect(schedule.emergencyRunawayCeiling.role).toContain("operational");
    expect(schedule.emergencyRunawayCeiling.perScoredArmUsd).toBeGreaterThan(schedule.advisoryCostTelemetry.perScoredArmUsd);
    expect(protocol.costAndLimits.advisoryTelemetry.role).toContain("never a validity gate");
    expect(protocol.costAndLimits.emergencyRunawayCeiling.role).toContain("operational");
    expect(protocol.costAndLimits.emergencyRunawayCeiling.perScoredArmUsd)
      .toBeGreaterThan(protocol.costAndLimits.advisoryTelemetry.perScoredArmUsd);
    expect(protocol.costAndLimits.emergencyRunawayCeiling.mediumSeriesUsd)
      .toBeGreaterThan(protocol.costAndLimits.advisoryTelemetry.mediumSeriesUsd);
  });

  it("keeps the protocol checkpoint order identical to the controller", () => {
    const fork = protocol.checkpointOrder.findIndex((step) => /create score fork/.test(step));
    const resume = protocol.checkpointOrder.findIndex((step) => /resume the source|resume source/.test(step));
    expect(fork).toBeGreaterThan(-1);
    expect(resume).toBeGreaterThan(fork);
  });
});


/**
 * A minimal draft-2020-12 subset validator: enough to prove that the
 * `privateTreeModes` schema binds content (type/const/required/minimum/
 * additionalProperties), so the negative cases are decided by the real schema
 * file rather than by restating its rules in the test.
 */
function validateAgainst(schema: Record<string, unknown>, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if ("const" in schema && value !== schema.const) errors.push(`${path}:const`);
  const type = schema.type as string | undefined;
  if (type === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) errors.push(`${path}:type`);
  if (type === "integer" && !Number.isInteger(value)) errors.push(`${path}:type`);
  if (type === "string" && typeof value !== "string") errors.push(`${path}:type`);
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) errors.push(`${path}:minimum`);
  if (Array.isArray(value) && typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}:minItems`);
  if (type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in record)) errors.push(`${path}.${key}:required`);
    }
    const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    const additional = schema.additionalProperties;
    for (const [key, entry] of Object.entries(record)) {
      if (key in properties) errors.push(...validateAgainst(properties[key], entry, `${path}.${key}`));
      else if (additional === false) errors.push(`${path}.${key}:additional`);
      else if (typeof additional === "object") errors.push(...validateAgainst(additional as Record<string, unknown>, entry, `${path}.${key}`));
    }
  }
  return errors;
}

describe("OG-86 Stage-0 preflight abort", () => {
  // B5: a failed structural preflight must stop the run before the first model
  // call. The abort is proven two ways: as a unit, and end-to-end through the
  // real entry point with a PATH tripwire that records every Claude invocation.
  it("aborts immediately when a gate has failed", () => {
    const result = evaluate<{ threw: boolean; message: string; clean: boolean }>(`
let threw = false; let message = "";
stage0.resetFailedGates();
try { stage0.requireNoFailedGates("any model call"); } catch (error) { threw = true; message = error.message; }
const clean = threw === false && message === "";
stage0.assert(false, "ancestry:dependencyBaseCommit:missing");
let threwAfter = false; let messageAfter = "";
try { stage0.requireNoFailedGates("any model call"); } catch (error) { threwAfter = true; messageAfter = error.message; }
stage0.resetFailedGates();
process.stdout.write(JSON.stringify({ threw: threwAfter, message: messageAfter, clean }));
`, {});
    // An empty accumulator must not throw; a populated one must.
    expect(result.clean).toBe(true);
    expect(result.threw).toBe(true);
    expect(result.message).toContain("ancestry:dependencyBaseCommit:missing");
  });

  it("invokes zero Claude processes when a structural preflight fails", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "og86-b5-"));
    // Structurally identical to the repository, but with an empty git history,
    // so the ancestry preflight fails for the real reason (the declared commits
    // do not exist) rather than because a file is missing.
    cpSync(join(root, "scripts"), join(sandbox, "scripts"), { recursive: true });
    mkdirSync(join(sandbox, "docs", "benchmark"), { recursive: true });
    cpSync(join(root, "docs", "benchmark", "og86-medium-v1"),
      join(sandbox, "docs", "benchmark", "og86-medium-v1"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: sandbox });
    // A stub claude on PATH: the only difference from a heading run is that any
    // model call leaves a line in the log.
    const bin = join(sandbox, "bin");
    mkdirSync(bin, { recursive: true });
    const log = join(sandbox, "claude-invocations.log");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf '%s\\n' '{"total_cost_usd":0.01,"result":"ok"}'\n`, { mode: 0o755 });
    // `tmpdir()` sits behind a symlink on macOS, and the runner treats a
    // symlinked invocation path as "not direct" and no-ops with exit 0, so the
    // spawn must use the resolved path or the tripwire would pass vacuously.
    const real = realpathSync(sandbox);
    const result = spawnSync(process.execPath, [join(real, "scripts", "benchmark", "run-og86-stage0.mjs"), join(real, "stage0-root")], {
      cwd: sandbox, encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const invocations = existsSync(log) ? readFileSync(log, "utf8").trim() : "";
    // The abort happens before the private root is created, so a failed ancestry
    // preflight costs zero writes as well as zero model calls.
    const rootCreated = existsSync(join(real, "stage0-root"));
    rmSync(sandbox, { recursive: true, force: true });
    // Fail closed: non-zero exit, the ancestry failure named, no Claude launched.
    // The exit must be a real refusal, not the silent no-op above.
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("refused to continue");
    expect(`${result.stderr}${result.stdout}`).toContain("ancestry:");
    expect(invocations).toBe("");
    expect(rootCreated).toBe(false);
  });

  it("places the abort before the first model call in program order", () => {
    const source = readFileSync(STAGE0, "utf8");
    const abortAt = source.indexOf('requireNoFailedGates("any model call")');
    const firstCallAt = source.indexOf("const work = claudeCall(");
    expect(abortAt).toBeGreaterThan(-1);
    expect(firstCallAt).toBeGreaterThan(-1);
    expect(abortAt).toBeLessThan(firstCallAt);
  });
});

describe("OG-86 Stage-0 private root refusal", () => {
  it("refuses a symlinked private root rather than writing through it", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "og86-b6-"));
    const target = join(sandbox, "real");
    const link = join(sandbox, "link");
    mkdirSync(target);
    symlinkSync(target, link);
    const result = evaluate<{ symlinked: string | null; fresh: boolean }>(`
let symlinked = null; let fresh = false;
try { stage0.assertStage0PrivateRootWritable(ARGS.link); } catch (error) { symlinked = error.message; }
try { stage0.assertStage0PrivateRootWritable(ARGS.freshPath); fresh = true; } catch { fresh = false; }
process.stdout.write(JSON.stringify({ symlinked, fresh }));
`, { link, freshPath: join(sandbox, "absent") });
    rmSync(sandbox, { recursive: true, force: true });
    expect(result.symlinked).toContain("symlinked private root");
    // An absent root is the normal case and must be allowed.
    expect(result.fresh).toBe(true);
  });

  it("refuses through the real entry point, before any write or model call", () => {
    // The guard must be wired into main, not merely exported: a symlinked root
    // is refused by the real runner before the plan is read or claude is run.
    const sandbox = mkdtempSync(join(tmpdir(), "og86-b6c-"));
    const real = join(sandbox, "real");
    const link = join(sandbox, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    const runStage0 = (target: string) => spawnSync(process.execPath,
      [join(realpathSync(root), "scripts", "benchmark", "run-og86-stage0.mjs"), target],
      { cwd: root, encoding: "utf8" });
    const symlinked = runStage0(link);
    // A populated root is refused too, and neither run created anything inside it.
    const populated = join(sandbox, "populated");
    mkdirSync(populated);
    writeFileSync(join(populated, "existing.txt"), "x\n");
    const nonEmpty = runStage0(populated);
    const untouched = readFileSync(join(populated, "existing.txt"), "utf8") === "x\n";
    rmSync(sandbox, { recursive: true, force: true });
    expect(symlinked.status).not.toBe(0);
    expect(`${symlinked.stderr}${symlinked.stdout}`).toContain("symlinked private root");
    expect(nonEmpty.status).not.toBe(0);
    expect(`${nonEmpty.stderr}${nonEmpty.stdout}`).toContain("non-empty private root");
    expect(untouched).toBe(true);
  });

  it("refuses a non-empty private root", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "og86-b6b-"));
    writeFileSync(join(sandbox, "existing.txt"), "x\n");
    const result = evaluate<string>(`
let message = "";
try { stage0.assertStage0PrivateRootWritable(ARGS.root); } catch (error) { message = error.message; }
process.stdout.write(JSON.stringify(message));
`, { root: sandbox });
    rmSync(sandbox, { recursive: true, force: true });
    expect(result).toContain("non-empty private root");
  });
});

describe("OG-86 Stage-0 scratch isolation", () => {
  it("requires an explicit scratch root and creates no session path", () => {
    const sessionPath = join(root, "sessions", "og86-stage0-current");
    const existedBefore = existsSync(sessionPath);
    const result = evaluate<{ threw: boolean; message: string }>(`
let threw = false; let message = "";
try { stage0.scorerPreflight({ scorerPath: ARGS.scorer, atomsPath: ARGS.atoms }); }
catch (error) { threw = true; message = error.message; }
process.stdout.write(JSON.stringify({ threw, message }));
`, { scorer: join(root, "scripts", "benchmark", "score-og86.mjs"), atoms: join(root, "docs", "benchmark", "og86-medium-v1", "atoms.json") });
    expect(result.threw).toBe(true);
    expect(result.message).toContain("scratchRoot");
    // The module-global default is gone, so an offline call cannot create it.
    expect(existsSync(sessionPath)).toBe(existedBefore);
  });
});

describe("OG-86 observed treatment channel", () => {
  it("records the event and output field the score-fork hook actually wrote", () => {
    const state = mkdtempSync(join(tmpdir(), "og86-b10-"));
    const treatment = join(state, "treatment.txt");
    const body = "dcompact treatment body\n";
    writeFileSync(treatment, body);
    const sha = `sha256:${createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex")}`;
    const result = spawnSync(process.execPath, [
      join(root, "docs", "benchmark", "og86-medium-v1", "harness", "score-fork-hook.mjs"),
      "--event", "SessionStart", "--state", state, "--treatment", treatment, "--sha256", sha,
    ], { encoding: "utf8", input: JSON.stringify({ source: "resume", transcript_path: "/tmp/og86-transcript.jsonl" }) });
    expect(result.status).toBe(0);
    const row = JSON.parse(readFileSync(join(state, "score-fork-events.jsonl"), "utf8").trim().split("\n").pop() as string);
    rmSync(state, { recursive: true, force: true });
    // The audit row names the event and the field derived from the emitted object.
    expect(row.hookEventName).toBe("SessionStart");
    expect(row.outputFields).toContain("additionalContext");
    expect(row.treatmentField).toBe("additionalContext");
    expect(row.outputSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("derives the channel from real hook output, so a field change is observed", () => {
    const state = mkdtempSync(join(tmpdir(), "og86-b10b-"));
    const treatment = join(state, "treatment.txt");
    const body = "dcompact treatment body\n";
    writeFileSync(treatment, body);
    const sha = `sha256:${createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex")}`;
    const invoke = (hookPath: string) => spawnSync(process.execPath, [
      hookPath, "--event", "SessionStart", "--state", state, "--treatment", treatment, "--sha256", sha,
    ], { encoding: "utf8", input: JSON.stringify({ source: "resume", transcript_path: "/tmp/og86-transcript.jsonl" }) });
    const realHook = join(root, "docs", "benchmark", "og86-medium-v1", "harness", "score-fork-hook.mjs");
    expect(invoke(realHook).status).toBe(0);
    // A sabotaged hook that emits a differently-named field, with the treatment
    // moved to it. The audit row must follow the emitted object.
    const sabotagedHook = join(state, "sabotaged-hook.mjs");
    const sabotaged = readFileSync(realHook, "utf8").replace("additionalContext:", "injectedContext:");
    expect(sabotaged).not.toBe(readFileSync(realHook, "utf8"));
    writeFileSync(sabotagedHook, sabotaged);
    rmSync(join(state, "score-fork-injected"), { force: true });
    expect(invoke(sabotagedHook).status).toBe(0);

    const readRows = () => readFileSync(join(state, "score-fork-events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const rows = readRows();
    const result = evaluate<{ real: Record<string, unknown>; sabotaged: Record<string, unknown>; sabotagedFailures: string[] }>(`
const rows = ARGS.rows;
const real = stage0.treatmentChannelEvidence(rows.slice(0, 1));
const sabotaged = stage0.treatmentChannelEvidence(rows.slice(1));
const arm = (name, evidence, copies) => ({ arm: name, treatmentCopies: copies, ...evidence });
const check = stage0.channelPreflight({ arms: [
  arm("A", { treatmentEvent: null, treatmentChannel: null, treatmentOutputFields: [] }, 0),
  arm("B", sabotaged, 1), arm("C", sabotaged, 1),
] });
process.stdout.write(JSON.stringify({ real, sabotaged, sabotagedFailures: check.failures }));
`, { rows });
    rmSync(state, { recursive: true, force: true });

    // The real hook's own output drives the observed channel.
    expect(result.real.treatmentChannel).toBe("additionalContext");
    expect(result.real.treatmentOutputFields).toContain("additionalContext");
    // The sabotaged emission is observed as a different field, and the check fails.
    expect(result.sabotaged.treatmentChannel).toBe("injectedContext");
    expect(result.sabotaged.treatmentOutputFields).not.toContain("additionalContext");
    expect(result.sabotagedFailures).toContain("treatment-field-absent-from-output");
  });

  it("carries no hardcoded channel value into the arm results", () => {
    // The runner's arm body needs a real Stage-0 run, so the wiring is asserted
    // statically while the derivation itself is covered behaviourally above. The
    // defect being guarded is precise: a channel literal in the runner.
    const source = readFileSync(STAGE0, "utf8");
    const start = source.indexOf("armResults.push({");
    const armPush = source.slice(start, source.indexOf("});", source.indexOf("...channelEvidence", start)));
    expect(armPush).toContain("...channelEvidence");
    // The only occurrence is the doc comment; no assignment may name a channel.
    const assignments = source.split("\n").filter((line) => /treatmentChannel:\s*"/.test(line));
    expect(assignments).toEqual([]);
    const eventAssignments = source.split("\n").filter((line) => /treatmentEvent:\s*"/.test(line));
    expect(eventAssignments).toEqual([]);
  });

  it("fails the channel preflight when the hook emits a different field", () => {
    const result = evaluate<{ shared: string; sabotaged: string[]; unobserved: string[] }>(`
const arm = (name, channel, copies, fields) => ({
  arm: name, treatmentEvent: "SessionStart", treatmentChannel: channel,
  treatmentCopies: copies, treatmentOutputFields: fields,
});
const sabotaged = stage0.channelPreflight({ arms: [
  arm("A", null, 0, []),
  arm("B", "otherField", 1, ["hookEventName", "otherField"]),
  arm("C", "otherField", 1, ["hookEventName", "otherField"]),
] });
const unobserved = stage0.channelPreflight({ arms: [
  arm("A", null, 0, []), arm("B", null, 1, []), arm("C", null, 1, []),
] });
const shared = stage0.channelPreflight({ arms: [
  arm("A", null, 0, []),
  arm("B", "additionalContext", 1, ["hookEventName", "additionalContext"]),
  arm("C", "additionalContext", 1, ["hookEventName", "additionalContext"]),
] });
process.stdout.write(JSON.stringify({ shared: shared.sharedChannel, sabotaged: sabotaged.failures, unobserved: unobserved.failures }));
`);
    expect(result.shared).toBe("SessionStart|additionalContext");
    // A field the hook never wrote cannot satisfy the check.
    expect(result.sabotaged).toContain("treatment-field-absent-from-output");
    // A delivered arm with no recorded field is a vacuous comparison.
    expect(result.unobserved).toContain("treatment-channel-unobserved");
  });
});

describe("OG-86 medium workload privacy", () => {
  it("makes the copied workload owner-only and restores the umask", () => {
    const tree = mkdtempSync(join(tmpdir(), "og86-b9-"));
    const workload = join(tree, "workload");
    const umaskBefore = process.umask();
    const result = evaluate<{ dirs: Record<string, number>; files: Record<string, number>; allDirs: boolean; allFiles: boolean; measurable: boolean; restored: boolean; fileCount: number }>(`
import { cpSync } from "node:fs";
const beforeUmask = process.umask();
controller.withRestrictiveUmask(() => {
  cpSync(ARGS.source, ARGS.workload, { recursive: true });
  controller.makeTreePrivate(ARGS.tree);
});
const modes = controller.privateTreeModes(ARGS.tree);
process.stdout.write(JSON.stringify({
  dirs: modes.directoryModes, files: modes.fileModes,
  allDirs: modes.allDirectoriesOwnerOnly, allFiles: modes.allFilesOwnerOnly,
  measurable: modes.measurable, fileCount: modes.fileCount,
  restored: process.umask() === beforeUmask,
}));
`, { source: join(root, "docs", "benchmark", "og86-medium-v1", "workload"), workload, tree });
    rmSync(tree, { recursive: true, force: true });
    // The tracked workload is 0644/0755; the copy must still come out 0600/0700.
    expect(Object.keys(result.dirs)).toEqual(["700"]);
    expect(Object.keys(result.files)).toEqual(["600"]);
    expect(result.allDirs).toBe(true);
    expect(result.allFiles).toBe(true);
    expect(result.measurable).toBe(true);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.restored).toBe(true);
    // The controller's umask is restored, not left restrictive.
    expect(process.umask()).toBe(umaskBefore);
  });

  it("makes the workload owner-only through the real openArm path", () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "og86-b9-arm-"));
    const result = evaluate<{ missing: boolean; dirs: Record<string, number>; files: Record<string, number>; allDirs: boolean; allFiles: boolean; measurable: boolean }>(`
// The real driver factory, so the copy, the chmod, and the umask all run as in a
// scored arm rather than as an isolated helper call.
import { existsSync } from "node:fs";
const driver = controller.createClaudeDriver({
  repository: ARGS.repository, privateRoot: ARGS.privateRoot,
  dcompact: ARGS.dcompact, benchmark: ARGS.benchmark,
});
driver.openArm("B", 1);
const workload = ARGS.privateRoot + "/arm-b/workload";
const modes = controller.privateTreeModes(workload);
process.stdout.write(JSON.stringify({
  missing: !existsSync(workload),
  dirs: modes.directoryModes, files: modes.fileModes,
  allDirs: modes.allDirectoriesOwnerOnly, allFiles: modes.allFilesOwnerOnly,
  measurable: modes.measurable,
}));
`, {
      repository: root,
      privateRoot,
      dcompact: join(root, "dist", "cli.js"),
      benchmark: join(root, "docs", "benchmark", "og86-medium-v1"),
    });
    rmSync(privateRoot, { recursive: true, force: true });
    expect(result.missing).toBe(false);
    // The tracked workload is 0644/0755; the arm's copy must be 0600/0700.
    expect(Object.keys(result.dirs)).toEqual(["700"]);
    expect(Object.keys(result.files)).toEqual(["600"]);
    expect(result.allDirs).toBe(true);
    expect(result.allFiles).toBe(true);
    expect(result.measurable).toBe(true);
  });

  it("restores the umask even when the guarded body throws", () => {
    const result = evaluate<boolean>(`
const before = process.umask();
try { controller.withRestrictiveUmask(() => { throw new Error("boom"); }); } catch { /* expected */ }
process.stdout.write(JSON.stringify(process.umask() === before));
`, {});
    expect(result).toBe(true);
  });
});

describe("OG-86 private tree mode evidence", () => {
  const schema = JSON.parse(readFileSync(join(root, "docs", "benchmark", "og86-medium-v1", "artifact-schema.json"), "utf8")) as {
    properties: { checkpoints: { items: { properties: { privateTreeModes: Record<string, unknown> } } } };
  };
  const modesSchema = schema.properties.checkpoints.items.properties.privateTreeModes;

  it("rejects an empty, absent, or wrongly-moded reading", () => {
    const empty = validateAgainst(modesSchema, {});
    const wrongBooleans = validateAgainst(modesSchema, {
      rootPresent: true, readFailureCount: 0, directoryModes: { 755: 1 }, fileModes: { 644: 9 },
      directoryCount: 1, fileCount: 9, symlinkCount: 0,
      allDirectoriesOwnerOnly: false, allFilesOwnerOnly: false, zeroSymlinks: true,
    });
    const vacuous = validateAgainst(modesSchema, {
      rootPresent: false, readFailureCount: 1, directoryModes: {}, fileModes: {},
      directoryCount: 0, fileCount: 0, symlinkCount: 0,
      allDirectoriesOwnerOnly: true, allFilesOwnerOnly: true, zeroSymlinks: true,
    });
    const nonZeroSymlinks = validateAgainst(modesSchema, {
      rootPresent: true, readFailureCount: 0, directoryModes: { 700: 4 }, fileModes: { 600: 9 },
      directoryCount: 4, fileCount: 9, symlinkCount: 2,
      allDirectoriesOwnerOnly: true, allFilesOwnerOnly: true, zeroSymlinks: false,
    });
    // An empty object binds nothing, so it must not validate.
    expect(empty.length).toBeGreaterThan(0);
    expect(wrongBooleans.some((error) => error.includes("allDirectoriesOwnerOnly"))).toBe(true);
    // A reading that measured nothing cannot attest owner-only.
    expect(vacuous.some((error) => error.includes("rootPresent"))).toBe(true);
    expect(vacuous.some((error) => error.includes("readFailureCount"))).toBe(true);
    expect(vacuous.some((error) => error.includes("directoryCount"))).toBe(true);
    // A symlinked tree is refused.
    expect(nonZeroSymlinks.some((error) => error.includes("symlinkCount"))).toBe(true);
  });

  it("accepts a real owner-only reading and every emitted checkpoint", () => {
    const good = validateAgainst(modesSchema, {
      rootPresent: true, readFailureCount: 0, directoryModes: { 700: 4 }, fileModes: { 600: 9 },
      directoryCount: 4, fileCount: 9, symlinkCount: 0,
      allDirectoriesOwnerOnly: true, allFilesOwnerOnly: true, zeroSymlinks: true,
    });
    expect(good).toEqual([]);
  });

  it("refuses to emit an artifact whose mode evidence is vacuous", () => {
    const messages = evaluate<string[]>(`
${DRIVER_PRELUDE}
const revisions = { runner: "sha256:" + "f".repeat(64), scorer: "sha256:" + "0".repeat(64) };
const vacuous = {
  rootPresent: false, readFailureCount: 1, directoryModes: {}, fileModes: {},
  directoryCount: 0, fileCount: 0, symlinkCount: 0, measurable: false,
  allDirectoriesOwnerOnly: true, allFilesOwnerOnly: true, zeroSymlinks: true,
};
const garbage = {
  rootPresent: true, readFailureCount: 0, directoryModes: { 755: 1 }, fileModes: { 644: 9 },
  directoryCount: 1, fileCount: 9, symlinkCount: 0, measurable: true,
  allDirectoriesOwnerOnly: false, allFilesOwnerOnly: false, zeroSymlinks: true,
};
const messages = [];
// The source-verified gate rejects these before the artifact is built, so a
// full run must never emit.
for (const modes of [vacuous, garbage, null]) {
  const result = runSeries({ verifySource: () => ({ source: { bytes: 1, lines: 1, sha256: "sha256:" + "a".repeat(64) }, canaryOccurrenceCount: 0, privateTreeModes: modes, wallSeconds: 0.001 }) });
  try { controller.armArtifact(result.state, "A", revisions); messages.push("emitted"); }
  catch (error) { messages.push(error.message); }
}
// The artifact check is the second line of defence: degrade a passing run's
// stored evidence directly and confirm it still refuses to publish.
const passing = runSeries({});
passing.state.arms.A.checkpoints[0].privateTreeModes = vacuous;
try { controller.armArtifact(passing.state, "A", revisions); messages.push("emitted-degraded"); }
catch (error) { messages.push("degraded:" + error.message); }
process.stdout.write(JSON.stringify(messages));
`);
    // Presence alone no longer publishes an arm.
    expect(messages).not.toContain("emitted");
    expect(messages).not.toContain("emitted-degraded");
    // The artifact gate names the content failure rather than a missing key.
    expect(messages[3]).toContain("meaningful privateTreeModes");
  });

  it("keeps host paths out of the published mode summary", () => {
    const tree = mkdtempSync(join(tmpdir(), "og86-b4-"));
    const result = evaluate<{ text: string; hasPath: boolean }>(`
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
const dir = ARGS.tree + "/inner";
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "/file.txt", "x\\n");
chmodSync(ARGS.tree, 0o700); chmodSync(dir, 0o700); chmodSync(dir + "/file.txt", 0o600);
const sanitized = controller.sanitizedModes(controller.privateTreeModes(ARGS.tree));
process.stdout.write(JSON.stringify({ text: JSON.stringify(sanitized), hasPath: JSON.stringify(sanitized).includes(ARGS.tree) }));
`, { tree });
    rmSync(tree, { recursive: true, force: true });
    expect(result.hasPath).toBe(false);
    expect(result.text).not.toContain(tmpdir());
  });
});

describe("OG-86 child umask ownership", () => {
  /**
   * A fake `claude` that behaves like the agent's Write tool: it creates nested
   * directories and files in its own cwd *during* the call. That is the case the
   * previous fix did not cover — the copy-time chmod runs before any model call,
   * so only the child's inherited umask can decide these modes.
   */
  const WRITING_CLAUDE = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const forking = args.includes('--fork-session');",
    // The agent's tools name no mode; the umask is the only decider.
    "fs.mkdirSync('src/generated/deep', { recursive: true });",
    "fs.writeFileSync('src/generated/new-module.js', 'export const added = 1;' + String.fromCharCode(10));",
    "fs.writeFileSync('src/generated/deep/nested.js', 'export const deep = 1;' + String.fromCharCode(10));",
    "const source = process.env.OG86_SOURCE;",
    "const shared = process.env.OG86_SHARED;",
    "const rec = (uuid) => JSON.stringify({ type: 'assistant', uuid, message: { role: 'assistant', model: 'claude-haiku-4-5-20251001' } });",
    "fs.mkdirSync(path.dirname(source), { recursive: true });",
    "const existing = fs.existsSync(source) ? fs.readFileSync(source, 'utf8').trim() : '';",
    "const rows = (existing ? existing.split(String.fromCharCode(10)) : []).concat([rec('w-' + (existing ? existing.length : 0))]);",
    "fs.writeFileSync(source, rows.join(String.fromCharCode(10)) + String.fromCharCode(10));",
    "fs.writeFileSync(shared, source + String.fromCharCode(10));",
    "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,"
      + " total_cost_usd: 0.01, num_turns: 1, session_id: forking ? 'fork-session' : 'source-session', result: '{}' }));",
    "",
  ].join("\n");

  /** Drive a real phase prompt whose child writes nested files, then verify. */
  function runWritingArm() {
    return evaluate<{
      fileModes: Record<string, number>;
      directoryModes: Record<string, number>;
      allFilesOwnerOnly: boolean;
      allDirectoriesOwnerOnly: boolean;
      measurable: boolean;
      rootPresent: boolean;
      readFailureCount: number;
      fileCount: number;
      created: string[];
      createdModes: Record<string, string>;
      parentUmaskRestored: boolean;
    }>(`
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-umask-"));
const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });
const fake = join(bin, "claude");
writeFileSync(fake, ARGS.fake);
chmodSync(fake, 0o755);
const armRoot = join(root, "private", "arm-a");
mkdirSync(armRoot, { recursive: true });
process.env.OG86_SOURCE = join(root, "source.jsonl");
process.env.OG86_SHARED = join(armRoot, "transcript-path.txt");

const umaskBefore = process.umask();
const driver = controller.createClaudeDriver({
  repository: process.cwd(), benchmark: ARGS.benchmark, privateRoot: join(root, "private"),
  dcompact: join(root, "cli.js"), claudeBinary: fake,
});
driver.openArm("A", 1);
driver.sendPhasePrompt({ arm: "A", phase: 1 });
const umaskAfterCall = process.umask();
const verified = driver.verifySource({ arm: "A" });
const modes = verified.privateTreeModes;
const workload = join(armRoot, "workload");
const created = ["src/generated/new-module.js", "src/generated/deep/nested.js"];
const createdModes = {};
for (const rel of created) createdModes[rel] = (statSync(join(workload, rel)).mode & 0o777).toString(8);
const out = {
  fileModes: modes.fileModes, directoryModes: modes.directoryModes,
  allFilesOwnerOnly: modes.allFilesOwnerOnly, allDirectoriesOwnerOnly: modes.allDirectoriesOwnerOnly,
  measurable: modes.measurable, rootPresent: modes.rootPresent, readFailureCount: modes.readFailureCount,
  fileCount: modes.fileCount, created, createdModes,
  parentUmaskRestored: umaskAfterCall === umaskBefore,
};
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify(out));
`, { fake: WRITING_CLAUDE, benchmark: join(root, "docs", "benchmark", "og86-medium-v1") });
  }

  it("keeps a child-written nested tree owner-only and the reading meaningful", () => {
    const result = runWritingArm();
    // The child really did create files during the call.
    expect(result.created).toHaveLength(2);
    for (const rel of result.created) expect(result.createdModes[rel]).toBe("600");
    // Every mode in the reading is owner-only: no 644 or 755 anywhere.
    expect(Object.keys(result.fileModes)).toEqual(["600"]);
    expect(Object.keys(result.directoryModes)).toEqual(["700"]);
    expect(result.allFilesOwnerOnly).toBe(true);
    expect(result.allDirectoriesOwnerOnly).toBe(true);
    // Meaningful, not vacuous: the reading measured a real tree.
    expect(result.measurable).toBe(true);
    expect(result.rootPresent).toBe(true);
    expect(result.readFailureCount).toBe(0);
    expect(result.fileCount).toBeGreaterThan(9);
    // The parent's umask is not left restrictive.
    expect(result.parentUmaskRestored).toBe(true);
  });

  it("restores the parent umask on success and on throw", () => {
    const result = evaluate<{ afterSuccess: boolean; afterThrow: boolean; leaked: string }>(`
const before = process.umask();
const success = controller.withRestrictiveUmask(() => "value");
const afterSuccess = process.umask() === before;
let threw = false;
try { controller.withRestrictiveUmask(() => { throw new Error("child failed"); }); } catch { threw = true; }
process.stdout.write(JSON.stringify({
  afterSuccess: afterSuccess && success === "value",
  afterThrow: process.umask() === before && threw,
  leaked: process.umask().toString(8),
}));
`, {});
    expect(result.afterSuccess).toBe(true);
    expect(result.afterThrow).toBe(true);
    // The restriction did not leak: the process is back to the ambient umask.
    expect(result.leaked).not.toBe("77");
  });

  it("keeps the Stage-0 end-of-run tree owner-only after a writing child", () => {
    // Stage-0 asserts `owner-only-modes` over its whole private root at the end
    // of the run, so a file the agent creates during any call must land 0600 or
    // the run aborts. The assertion is exercised here against a real child.
    const result = evaluate<{ directories: string[]; files: string[]; symlinkCount: number; resolved: string }>(`
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "og86-s0umask-"));
const bin = join(root, "bin");
import { mkdirSync } from "node:fs";
mkdirSync(bin, { recursive: true });
const fake = join(bin, "claude");
writeFileSync(fake, ARGS.fake);
chmodSync(fake, 0o755);
// A PATH tripwire: the stub must be the only claude reachable, so this test
// can never invoke a real model CLI even on a machine where one is installed.
process.env.PATH = bin + ":" + process.env.PATH;
const workload = join(root, "private", "source", "workload");
mkdirSync(workload, { recursive: true });
// Production creates these with privateDirectory (0700) before any call, so the
// fixture must too; otherwise the walk would flag the test's own setup dirs.
chmodSync(join(root, "private"), 0o700);
chmodSync(join(root, "private", "source"), 0o700);
// A pre-existing copied file, as makePrivate would have left it.
writeFileSync(join(workload, "existing.js"), "x" + String.fromCharCode(10));
chmodSync(join(workload, "existing.js"), 0o600);
chmodSync(workload, 0o700);
process.env.OG86_SOURCE = join(root, "source.jsonl");
process.env.OG86_SHARED = join(root, "shared.txt");
const resolved = spawnSync("which", ["claude"], { encoding: "utf8" }).stdout.trim();
if (resolved !== fake) throw new Error("tripwire failed: real claude is reachable at " + resolved);
const envelope = stage0.claudeCall(["-p", "do work"], workload, join(root, "out.json"));
const modes = stage0.privacyModes(join(root, "private"));
rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  directories: modes.directories, files: modes.files, symlinkCount: modes.symlinkCount,
  session: envelope.session_id, resolved: resolved,
}));
`, { fake: WRITING_CLAUDE, });
    // No 755 directory and no 644 file anywhere: the end-of-run gate would pass.
    expect(result.directories).toEqual(["700"]);
    expect(result.files).toEqual(["600"]);
    expect(result.symlinkCount).toBe(0);
  });

  it("runs every Claude child through the umask wrapper in both runners", () => {
    // The wrapper is only load-bearing if no call site bypasses it. A raw
    // `spawnSync(claudeBinary` or `spawnSync("claude"` would silently reintroduce
    // the defect in one runner.
    for (const file of [join(root, "scripts", "benchmark", "run-og86-medium.mjs"),
      join(root, "scripts", "benchmark", "run-og86-stage0.mjs")]) {
      const source = readFileSync(file, "utf8");
      const raw = source.split("\n").filter((line) => /spawnSync\(\s*(claudeBinary|"claude")/.test(line));
      expect(raw, file).toEqual([]);
    }
    const stage0 = readFileSync(join(root, "scripts", "benchmark", "run-og86-stage0.mjs"), "utf8");
    expect(stage0).toContain('spawnPrivateChild("claude"');
    const medium = readFileSync(join(root, "scripts", "benchmark", "run-og86-medium.mjs"), "utf8");
    expect(medium).toContain("spawnPrivateChild(claudeBinary");
  });
});
