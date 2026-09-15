import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

interface Atom {
  id: string;
  phase: number;
  category: string;
  responseField: string;
  canonical: string;
  accepted: string[][];
  partial: string[];
  contradictions: string[];
  availableAfterCheckpoint: number;
  continuationCritical: boolean;
}

interface Case {
  label: string;
  response: Record<string, unknown>;
  checkpoint?: number;
  focus: string;
}

interface CaseResult {
  label: string;
  points: number;
  denominator: number;
  exact: number;
  partial: number;
  missing: number;
  falseFacts: number;
  criticalExact: boolean;
  focusOutcome: string | null;
  focusPoints: number | null;
}

const root = process.cwd();
const benchmark = join(root, "docs", "benchmark", "og86-medium-v1");
const atoms = JSON.parse(readFileSync(join(benchmark, "atoms.json"), "utf8")) as Atom[];

const responseFields = [...new Set(atoms.map((atom) => atom.responseField.split(".")[0]))];

// The scorer runs in a child process so the test exercises the shipped module rather
// than a re-implementation. The whole mutation matrix travels over stdin in one call:
// a 100-atom sweep is thousands of cases, and argv would overflow well before then.
function runCases(cases: Case[]): CaseResult[] {
  const script = `import { readFileSync } from "node:fs";` +
    `import { score } from ${JSON.stringify(new URL("../scripts/benchmark/score-og86.mjs", import.meta.url).href)};` +
    `const request = JSON.parse(readFileSync(0, "utf8"));` +
    `const results = request.cases.map((entry) => {` +
    `const result = score(request.atoms, entry.response, entry.checkpoint ?? 4);` +
    `const row = result.rows.find((candidate) => candidate.id === entry.focus);` +
    `return { label: entry.label, points: result.points, denominator: result.denominator, exact: result.exact, partial: result.partial, missing: result.missing, falseFacts: result.falseFacts, criticalExact: result.criticalExact, focusOutcome: row ? row.outcome : null, focusPoints: row ? row.points : null };` +
    `});` +
    `process.stdout.write(JSON.stringify(results));`;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    input: JSON.stringify({ atoms, cases }),
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout) as CaseResult[];
}

function blankResponse(): Record<string, unknown> {
  const response: Record<string, unknown> = { errors: { cause: [], fix: [] } };
  for (const field of responseFields) {
    if (field === "errors") continue;
    response[field] = [] as string[];
  }
  return response;
}

function field(values: Record<string, unknown>, field: string): string[] {
  const [first, second] = field.split(".");
  if (!second) return values[first] as string[];
  const parent = values[first] as Record<string, string[]>;
  return (parent[second] ??= []);
}

function withTexts(fieldName: string, texts: string[]): Record<string, unknown> {
  const response: Record<string, unknown> = {};
  const [first, second] = fieldName.split(".");
  if (second) response[first] = { [second]: [...texts] };
  else response[first] = [...texts];
  return response;
}

function completeResponse(drop?: string): Record<string, unknown> {
  const response = blankResponse();
  for (const atom of atoms) {
    if (atom.id === drop) continue;
    field(response, atom.responseField).push(atom.canonical);
  }
  return response;
}

// A wrong-field placement is any field other than the atom's own, including the sibling
// errors sub-field: linkage atoms are the only ones that may live in errors.
function wrongFields(atom: Atom): string[] {
  const home = atom.responseField;
  const candidates = responseFields.includes("errors")
    ? [...responseFields, "errors.cause", "errors.fix"]
    : responseFields;
  return candidates.filter((field) => field !== home);
}

describe("OG-86 frozen benchmark", () => {
  it("freezes exactly 25 atoms per checkpoint and 100 total", () => {
    expect(atoms).toHaveLength(100);
    expect(new Set(atoms.map((atom) => atom.id)).size).toBe(100);
    for (let phase = 1; phase <= 4; phase += 1) {
      expect(atoms.filter((atom) => atom.phase === phase)).toHaveLength(25);
    }
    for (const phase of atoms) {
      expect(phase.availableAfterCheckpoint).toBe(phase.phase);
    }
  });

  it("freezes the per-phase category distribution and critical sets", () => {
    const expected = {
      file_symbol: 5,
      requirement: 3,
      negative_constraint: 4,
      linkage: 4,
      command_test: 4,
      unresolved: 3,
      provenance: 2,
    };
    for (let phase = 1; phase <= 4; phase += 1) {
      const group = atoms.filter((atom) => atom.phase === phase);
      for (const [category, count] of Object.entries(expected)) {
        expect(group.filter((atom) => atom.category === category), `phase ${phase} ${category}`).toHaveLength(count);
      }
    }
    expect(atoms.filter((atom) => atom.continuationCritical)).toHaveLength(44);
    expect(atoms.filter((atom) => atom.contradictions.length > 0)).toHaveLength(16);
  });

  it("scores the canonical response exactly at every checkpoint", () => {
    const cases: Case[] = [1, 2, 3, 4].map((checkpoint) => ({
      label: `checkpoint ${checkpoint}`,
      response: completeResponse(),
      checkpoint,
      focus: "P1-FS-01",
    }));
    for (const result of runCases(cases)) {
      expect(result, result.label).toMatchObject({
        points: 25 * Number(result.label.split(" ")[1]),
        denominator: 25 * Number(result.label.split(" ")[1]),
        exact: 25 * Number(result.label.split(" ")[1]),
        partial: 0,
        missing: 0,
        falseFacts: 0,
        criticalExact: true,
      });
    }
  });

  it("drops exactly one exact atom when any single canonical text is omitted", () => {
    const results = runCases(atoms.map((atom) => ({
      label: atom.id,
      response: completeResponse(atom.id),
      focus: atom.id,
    })));
    expect(results).toHaveLength(100);
    for (const result of results) {
      expect(result, result.label).toMatchObject({
        points: 99,
        denominator: 100,
        exact: 99,
        partial: 0,
        missing: 1,
        focusOutcome: "missing",
        focusPoints: 0,
      });
    }
  });

  it("never credits an atom whose canonical text sits in the wrong field", () => {
    const cases: Case[] = [];
    for (const atom of atoms) {
      for (const misplaced of wrongFields(atom)) {
        cases.push({
          label: `${atom.id} in ${misplaced}`,
          response: withTexts(misplaced, [atom.canonical]),
          focus: atom.id,
        });
      }
    }
    const results = runCases(cases);
    expect(results.length).toBeGreaterThan(600);
    for (const result of results) {
      expect(result, result.label).toMatchObject({ exact: 0, focusOutcome: "missing", focusPoints: 0 });
    }
  });

  it("gives partial credit only to the atom that owns the partial evidence", () => {
    const results = runCases(atoms.map((atom) => ({
      label: atom.id,
      response: withTexts(atom.responseField, atom.partial),
      focus: atom.id,
    })));
    for (const result of results) {
      expect(result, result.label).toMatchObject({
        points: 0.5,
        exact: 0,
        partial: 1,
        missing: 99,
        focusOutcome: "partial",
        focusPoints: 0.5,
      });
    }
  });

  it("accepts every frozen alias and resolves contradictions ahead of accepted text", () => {
    const aliasCases: Case[] = atoms.map((atom) => ({
      label: `${atom.id} alias`,
      response: withTexts(atom.responseField, [atom.accepted[1][0]]),
      focus: atom.id,
    }));
    for (const result of runCases(aliasCases)) {
      expect(result, result.label).toMatchObject({ focusOutcome: "exact", focusPoints: 1 });
    }

    const contradictory = atoms.filter((atom) => atom.contradictions.length > 0);
    const contradictionCases: Case[] = [];
    for (const atom of contradictory) {
      contradictionCases.push({
        label: `${atom.id} contradiction only`,
        response: withTexts(atom.responseField, atom.contradictions),
        focus: atom.id,
      });
      contradictionCases.push({
        label: `${atom.id} accepted with contradiction`,
        response: withTexts(atom.responseField, [atom.canonical, ...atom.contradictions]),
        focus: atom.id,
      });
    }
    for (const result of runCases(contradictionCases)) {
      expect(result, result.label).toMatchObject({
        focusOutcome: "contradiction",
        focusPoints: 0,
        falseFacts: 1,
        criticalExact: false,
      });
    }
  });

  it("keeps an atom invisible until its checkpoint and mutates only its own denominator", () => {
    const cases: Case[] = [];
    for (const atom of atoms) {
      const before = atom.availableAfterCheckpoint - 1;
      if (before < 1) continue;
      cases.push({ label: `${atom.id}|before|${before}`, response: completeResponse(), checkpoint: before, focus: atom.id });
      cases.push({ label: `${atom.id}|dropped|${before}`, response: completeResponse(atom.id), checkpoint: before, focus: atom.id });
    }
    for (const result of runCases(cases)) {
      const [id, , before] = result.label.split("|");
      const ordinal = Number(before);
      // The atom is not yet eligible at this checkpoint, so it never appears in the row
      // set: omitting an unreachable atom must leave points and denominator untouched.
      expect(result, result.label).toMatchObject({
        denominator: ordinal * 25,
        points: ordinal * 25,
        exact: ordinal * 25,
        missing: 0,
        focusOutcome: null,
      });
      expect(atoms.find((atom) => atom.id === id)!.availableAfterCheckpoint, result.label).toBeGreaterThan(ordinal);
    }

    const firstPhase = atoms.filter((atom) => atom.phase === 1).map((atom) => atom.id);
    for (const id of firstPhase) {
      const [result] = runCases([{ label: id, response: completeResponse(id), checkpoint: 1, focus: id }]);
      expect(result, id).toMatchObject({ points: 24, denominator: 25, missing: 1, focusOutcome: "missing" });
    }
  });

  it("ignores an unexpected response field instead of changing recall", () => {
    const [baseline] = runCases([{ label: "baseline", response: completeResponse(), focus: "P1-FS-01" }]);
    const [changed] = runCases([{
      label: "extra field",
      response: { ...completeResponse(), unexpected: "not part of the rubric" },
      focus: "P1-FS-01",
    }]);
    const baselineScore = { ...baseline, label: "" };
    const changedScore = { ...changed, label: "" };
    expect(changedScore).toEqual(baselineScore);
  });

  it("keeps exactly two seeded workload failures", () => {
    const result = spawnSync(process.execPath, ["--test", join(benchmark, "workload", "test", "phase1.test.js")], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("fail 2");
  });

  it("passes the benchmark privacy scanner", () => {
    expect(() => execFileSync(process.execPath, [join(root, "scripts", "benchmark", "privacy-scan-og86.mjs"), benchmark], { encoding: "utf8" })).not.toThrow();
  });

  it("matches every frozen-input checksum", () => {
    const rows = readFileSync(join(benchmark, "checksums.sha256"), "utf8").trim().split("\n");
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) {
      const match = /^([0-9a-f]{64})[ ]{2}(.+)$/.exec(row);
      expect(match).not.toBeNull();
      const actual = createHash("sha256").update(readFileSync(join(benchmark, match![2]))).digest("hex");
      expect(actual, match![2]).toBe(match![1]);
    }
  });
});
