import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalize } from "../src/core/canonical.js";
import { payloadHash } from "../src/core/hash.js";
import { extractFixture, extractFixtureResult, readFixture, vectorFixtureNames } from "../test/helpers/vectors.js";
import type { Fact, Payload } from "../src/core/types.js";

const fixtureRoot = resolve(process.cwd(), "test/fixtures");
const names = vectorFixtureNames(fixtureRoot);
const expectedVectorNames = ["empty", "single-edit", "merge-order", "unicode-nfc", "paths-outside", "error-cycle", "unknown-tool", "crlf", "huge-command", "clock-env"];
if (JSON.stringify(names) !== JSON.stringify([...expectedVectorNames].sort())) throw new Error(`Expected exactly the ten SCHEMA vectors, found: ${names.join(", ")}`);

function writeActual(path: string, contents: string): void {
  writeFileSync(path, contents, "utf8");
}

function semanticFacts(payload: Payload): Fact[] {
  return payload.facts.map((fact) => ({ ...fact, evidence: [] }));
}

function extractEvents(events: ReturnType<typeof readFixture>["events"], fixture: ReturnType<typeof readFixture>): Payload {
  return extractFixture({ ...fixture, events });
}

const generated = new Map<string, { payload: Payload; hash: string }>();
for (const name of names) {
  const fixture = readFixture(name, fixtureRoot);
  const payload = extractFixture(fixture);
  const hash = payloadHash(payload);
  const result = extractFixtureResult(fixture);
  if (fixture.metadata.expectedDegraded !== undefined && JSON.stringify(result.degraded) !== JSON.stringify(fixture.metadata.expectedDegraded)) {
    throw new Error(`${name}: degraded mismatch (actual ${JSON.stringify(result.degraded)}, expected ${JSON.stringify(fixture.metadata.expectedDegraded)})`);
  }
  mkdirSync(fixture.directory, { recursive: true });
  if (fixture.metadata.equivalentTo === undefined) {
    writeActual(`${fixture.directory}/${name}.payload.json.actual`, `${JSON.stringify(payload, null, 2)}\n`);
    writeActual(`${fixture.directory}/${name}.hash.actual`, `${hash}\n`);
  }
  generated.set(name, { payload, hash });
  console.log(`${name}: ${hash}`);
}

const merge = generated.get("merge-order");
if (merge === undefined) throw new Error("merge-order vector did not generate");
const mergeFixture = readFixture("merge-order", fixtureRoot);
const permutations = [
  [...mergeFixture.events].reverse(),
  [...mergeFixture.events.slice(2), ...mergeFixture.events.slice(0, 2)],
];
for (const events of permutations) if (payloadHash(extractEvents(events, mergeFixture)) !== merge.hash) throw new Error("merge-order permutation changed the payload hash");

const crlf = generated.get("crlf");
if (crlf === undefined) throw new Error("crlf vector did not generate");
const crlfFixture = readFixture("crlf", fixtureRoot);
const lfEvents = readFixture("crlf", fixtureRoot).events.map((event) => ({ ...event, rawLine: typeof event.rawLine === "string" ? event.rawLine.replaceAll("\r\n", "\n") : new TextEncoder().encode(new TextDecoder().decode(event.rawLine).replaceAll("\r\n", "\n")) }));
const lfPayload = extractEvents(lfEvents, crlfFixture);
if (JSON.stringify(semanticFacts(crlf.payload)) !== JSON.stringify(semanticFacts(lfPayload))) throw new Error("crlf fixture changed extracted facts beyond line evidence");

const single = generated.get("single-edit");
const clock = generated.get("clock-env");
if (single === undefined || clock === undefined || clock.hash !== single.hash) throw new Error("clock-env must be an equivalence assertion to single-edit");
if (canonicalize(single.payload) !== canonicalize(clock.payload)) throw new Error("clock-env payload differs from single-edit");
console.log("Wrote .actual artifacts only; review and human-promote them to expected files.");
