/**
 * Shape drift — the mechanism behind "dcompact never silently mis-extracts" (CONCEPT §11.1).
 *
 * An adapter declares the transcript shapes it was verified against. This module compares the
 * shapes a transcript *actually* contains against that declaration, and reports a mismatch that
 * a caller stamps on every snapshot produced from the adapter until a human updates the
 * definition. It is deliberately independent of the mapper: a mapper that silently ignores a
 * record shape it does not recognize — the exact failure that would otherwise be invisible —
 * cannot suppress this check, because this check never asks the mapper anything.
 *
 * What is compared, and what deliberately is not:
 *
 * - **Compared:** the top-level `type` of every JSON object line, because that is the transcript
 *   envelope the agent owns. A record type the definition does not declare is drift.
 * - **Not compared:** tool names. Tool vocabulary drifts far more often than transcript shape,
 *   and it is already counted: an unmapped call lowers `coverage_ppm` and adds *no* degraded
 *   state (CONCEPT §11.3). Treating a new tool as drift would bury the count in noise.
 * - **Not compared:** content-block and per-field shapes. They are the mapper's own vocabulary
 *   and it reports them as diagnostics, which the framework turns into the same token.
 *
 * A line that cannot be decoded and parsed contributes `line:unparsed`, and a JSON line that is
 * not an object with a string `type` contributes `record:<other>`: neither is a declared shape,
 * so both are drift. Tokens are bounded before they are echoed — a record type is transcript
 * data, and a diagnostic must never carry unbounded prose out of an untrusted file.
 *
 * The recorded fixture hashes in the definition are the anchor for the declaration: they say
 * *which* transcript bytes the declared shapes were verified against. `verifyFixtures` compares
 * them, so a declaration cannot quietly diverge from the fixture a human reviewed.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { AdapterDefinition } from "./registry.js";

/**
 * The alphabet a record type must use to be expressible as a shape token. Anything else collapses
 * to `record:<other>`, which means a definition could not distinguish it from an undescribed
 * record — so a definition is not allowed to declare one (`registry.ts` checks this).
 */
export const SHAPE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Bounded report: a hostile transcript must not turn one drift into a megabyte of diagnostics. */
const MAX_UNKNOWN_TOKENS = 8;

export interface DriftReport {
  readonly drifted: boolean;
  readonly unknown: readonly string[];
}

export interface FixtureProblem {
  readonly path: string;
  readonly problem: string;
}

const textDecoder = new TextDecoder("utf-8");

function shapeToken(type: string): string {
  return SHAPE_TOKEN.test(type) ? `record:${type}` : "record:<other>";
}

/**
 * Visit the shape token of every physical line, stopping early when `visit` returns false.
 *
 * One pass over the bytes, tolerant of everything: this is a check *about* the transcript, so it
 * must survive the input the mapper is about to refuse.
 */
function walkShapeTokens(bytes: Uint8Array, visit: (token: string) => boolean): void {
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 0x0a) continue;
    const line = bytes.subarray(start, index);
    start = index + 1;
    if (line.length === 0) continue;
    let token: string;
    try {
      const value: unknown = JSON.parse(textDecoder.decode(line));
      if (typeof value !== "object" || value === null || Array.isArray(value)) token = "record:<other>";
      else {
        const type = (value as Record<string, unknown>).type;
        token = typeof type === "string" ? shapeToken(type) : "record:<other>";
      }
    } catch {
      token = "line:unparsed";
    }
    if (!visit(token)) return;
  }
}

/** Every shape token the transcript contains, sorted and deduplicated. */
export function transcriptShape(bytes: Uint8Array): string[] {
  const tokens = new Set<string>();
  walkShapeTokens(bytes, (token) => {
    tokens.add(token);
    return true;
  });
  return [...tokens].sort();
}

/**
 * The shapes the adapter declares it handles: its record vocabulary.
 *
 * The verified fixtures are deliberately *not* added to this set. They are the evidence that the
 * declaration matches real transcripts, and `verifyFixtures` requires every shape recorded from a
 * fixture to be declared — so a fixture can never be the only thing keeping a shape known, and
 * narrowing the vocabulary always narrows what the adapter accepts.
 */
export function declaredShape(definition: AdapterDefinition): string[] {
  const records = definition.transcript.records;
  const declared = new Set<string>();
  for (const type of [...records.conversational, ...records.non_conversational]) declared.add(shapeToken(type));
  return [...declared].sort();
}

/**
 * Compare the transcript being read against the adapter's declared shape.
 *
 * The scan stops once the unknown-token report is full, so a transcript whose shape is already
 * known to be undeclared costs a fraction of a full pass.
 */
export function detectDrift(definition: AdapterDefinition, bytes: Uint8Array): DriftReport {
  const declared = new Set(declaredShape(definition));
  const unknown = new Set<string>();
  walkShapeTokens(bytes, (token) => {
    if (declared.has(token)) return true;
    unknown.add(token);
    return unknown.size < MAX_UNKNOWN_TOKENS;
  });
  return { drifted: unknown.size > 0, unknown: [...unknown].sort() };
}

/**
 * Verify the declaration against the fixtures it names — the human-verified anchor of the
 * vocabulary.
 *
 * Three checks per fixture: the file still hashes to the recorded bytes; the shape recorded for
 * it still matches the shape those bytes produce; and every recorded shape is one the adapter
 * declares, so the fixture cannot quietly be the only place a shape is known. `root` is the
 * checkout the relative fixture paths resolve against, supplied by the caller — the framework
 * does not go looking for it.
 */
export function verifyFixtures(definition: AdapterDefinition, root: string): FixtureProblem[] {
  const problems: FixtureProblem[] = [];
  const declared = new Set(declaredShape(definition));
  for (const fixture of definition.fixtures) {
    const path = isAbsolute(fixture.path) ? fixture.path : join(root, fixture.path);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch {
      problems.push({ path: fixture.path, problem: "unreadable" });
      continue;
    }
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== fixture.sha256) {
      problems.push({ path: fixture.path, problem: "hash mismatch" });
      continue;
    }
    const observed = transcriptShape(bytes);
    if (observed.join(",") !== [...fixture.shape].sort().join(",")) {
      problems.push({ path: fixture.path, problem: "recorded shape does not match the fixture bytes" });
      continue;
    }
    const undeclared = observed.filter((token) => !declared.has(token));
    if (undeclared.length > 0) {
      problems.push({ path: fixture.path, problem: `recorded shape is not declared: ${undeclared.join(", ")}` });
    }
  }
  return problems;
}