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
}

interface Score {
  points: number;
  denominator: number;
  exact: number;
  missing: number;
  falseFacts: number;
  criticalExact: boolean;
}

const root = process.cwd();
const benchmark = join(root, "docs", "benchmark", "og86-medium-v1");
const atoms = JSON.parse(readFileSync(join(benchmark, "atoms.json"), "utf8")) as Atom[];

function score(selected: Atom[], response: Record<string, unknown>, checkpoint = 4): Score {
  const script = `import { score } from ${JSON.stringify(new URL("../scripts/benchmark/score-og86.mjs", import.meta.url).href)};` +
    `process.stdout.write(JSON.stringify(score(${JSON.stringify(selected)}, ${JSON.stringify(response)}, ${checkpoint})));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" })) as Score;
}

function completeResponse(): Record<string, unknown> {
  const response: Record<string, unknown> = { errors: { cause: [], fix: [] } };
  for (const atom of atoms) {
    const [first, second] = atom.responseField.split(".");
    if (second) {
      const parent = response[first] as Record<string, string[]>;
      (parent[second] ??= []).push(atom.canonical);
    } else {
      const values = (response[first] ??= []) as string[];
      values.push(atom.canonical);
    }
  }
  return response;
}

describe("OG-86 frozen benchmark", () => {
  it("freezes exactly 25 atoms per checkpoint and 100 total", () => {
    expect(atoms).toHaveLength(100);
    expect(new Set(atoms.map((atom) => atom.id)).size).toBe(100);
    for (let phase = 1; phase <= 4; phase += 1) {
      expect(atoms.filter((atom) => atom.phase === phase)).toHaveLength(25);
    }
  });

  it("scores the canonical response exactly", () => {
    expect(score(atoms, completeResponse())).toMatchObject({
      points: 100, denominator: 100, exact: 100, missing: 0, falseFacts: 0, criticalExact: true,
    });
  });

  it("detects a removed atom and a missing negative constraint", () => {
    const response = completeResponse();
    const negative = atoms.find((atom) => atom.id === "P4-NC-04")!;
    response.negative_constraints = (response.negative_constraints as string[]).filter((value) => value !== negative.canonical);
    const result = score(atoms, response);
    expect(result.points).toBeLessThan(100);
    expect(result.criticalExact).toBe(false);
  });

  it("accepts a frozen alias and counts a frozen contradiction", () => {
    const aliasAtom = atoms.find((atom) => atom.id === "P1-RQ-01")!;
    expect(score([aliasAtom], { requirements: [aliasAtom.accepted[1][0]] }, 1).exact).toBe(1);

    const contradictionAtom = atoms.find((atom) => atom.id === "P1-NC-02")!;
    expect(score([contradictionAtom], { negative_constraints: contradictionAtom.contradictions }, 1)).toMatchObject({
      points: 0, falseFacts: 1,
    });
  });

  it("detects swapped cause and fix fields", () => {
    const cause = atoms.find((atom) => atom.id === "P1-LK-01")!;
    expect(score([cause], { errors: { fix: [cause.canonical] } }, 1).exact).toBe(0);
    expect(score([cause], { errors: { cause: [cause.canonical] } }, 1).exact).toBe(1);
  });

  it("ignores an unexpected response field instead of changing recall", () => {
    const baseline = score(atoms, completeResponse());
    const changed = score(atoms, { ...completeResponse(), unexpected: "not part of the rubric" });
    expect(changed).toEqual(baseline);
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
