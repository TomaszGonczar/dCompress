import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../src/core/canonical.js";
import { extract, extractPayload } from "../src/core/extract/index.js";
import { lineHash, payloadHash } from "../src/core/hash.js";
import type { Fact, Payload } from "../src/core/types.js";
import {
  configForFixture,
  expectedHash,
  fixtureNames,
  parseTranscript,
  readFixture,
  type VectorFixture,
} from "./helpers/vectors.js";

const fixtureRoot = join(process.cwd(), "test", "fixtures");
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

function payloadFor(fixture: VectorFixture): Payload {
  return extractPayload(fixture.events, configForFixture(fixture));
}

function resultFor(fixture: VectorFixture) {
  return extract(fixture.events, configForFixture(fixture));
}

function factsWithoutEvidenceHashes(facts: readonly Fact[]) {
  return facts.map((fact) => ({
    ...fact,
    evidence: fact.evidence.map(({ line }) => ({ line })),
  }));
}

describe("normative extraction vectors", () => {
  it("keeps every fixture and expected artifact in the declared format", () => {
    const names = fixtureNames(fixtureRoot);
    expect(names).toHaveLength(10);

    for (const name of names) {
      const fixture = readFixture(name, fixtureRoot);
      expect(Object.prototype.hasOwnProperty.call(fixture.metadata, "pathBase")).toBe(true);
      expect(["repo", "cwd"]).toContain(fixture.metadata.pathBase);
      expect(payloadFor(fixture).path_base).toBe(fixture.metadata.pathBase);

      if (fixture.transcriptBytes.length > 0) {
        const lastByte = fixture.transcriptBytes.at(-1);
        expect(lastByte).not.toBe(0x0a);
        expect(lastByte).not.toBe(0x0d);
      }

      if (name === "clock-env") {
        expect(existsSync(join(fixture.directory, "clock-env.payload.json"))).toBe(false);
        expect(existsSync(join(fixture.directory, "clock-env.hash"))).toBe(false);
        continue;
      }

      const payloadPath = join(fixture.directory, `${name}.payload.json`);
      const hashPath = join(fixture.directory, `${name}.hash`);
      const payloadBytes = readFileSync(payloadPath);
      const payloadText = textDecoder.decode(payloadBytes);
      const parsedPayload = JSON.parse(payloadText) as Payload;
      expect(payloadText).toBe(`${JSON.stringify(parsedPayload, null, 2)}\n`);

      const hashText = textDecoder.decode(readFileSync(hashPath));
      expect(hashText).toMatch(/^sha256:[0-9a-f]{64}\n$/);
      expect(payloadHash(parsedPayload)).toBe(hashText.trimEnd());
      expect(expectedHash(name, fixtureRoot)).toBe(hashText.trimEnd());
    }
  });

  it("asserts the empty vector outcome", () => {
    const result = resultFor(readFixture("empty", fixtureRoot));

    expect(result.facts).toEqual([]);
    expect(result.counters.source_tool_calls).toBe(0);
    expect(result.counters.coverage_ppm).toBe(0);
    expect(result.degraded).toEqual(["extraction-empty"]);
  });

  it("asserts the single-edit evidence shape", () => {
    const fixture = readFixture("single-edit", fixtureRoot);
    const payload = payloadFor(fixture);

    expect(payload.facts).toHaveLength(1);
    const [fact] = payload.facts;
    expect(fact.kind).toBe("file.modified");
    expect(fact.key).toBe("src/dispatch.ts");
    expect(fact.evidence).toEqual([{ line: 1, sha256: lineHash(fixture.events[0].rawLine) }]);
    expect(fact.evidence).toHaveLength(1);
    expect(Object.keys(fact.evidence[0])).toEqual(["line", "sha256"]);
    expect(fact).not.toHaveProperty("path");
  });

  it("makes merge-order payloads and hashes invariant across permutations", () => {
    const fixture = readFixture("merge-order", fixtureRoot);
    const original = fixture.events;
    const permutation = [original[2], original[0], original[4], original[1], original[3]];
    const reversal = [...original].reverse();
    expect(permutation).not.toEqual(original);
    expect(reversal).not.toEqual(original);

    const payloads = [original, permutation, reversal].map((events) =>
      extractPayload(events, configForFixture(fixture)),
    );
    const canonicalPayloads = payloads.map((payload) => canonicalize(payload));
    const hashes = payloads.map((payload) => payloadHash(payload));

    expect(payloads[1]).toEqual(payloads[0]);
    expect(payloads[2]).toEqual(payloads[0]);
    expect(canonicalPayloads[1]).toBe(canonicalPayloads[0]);
    expect(canonicalPayloads[2]).toBe(canonicalPayloads[0]);
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[2]).toBe(hashes[0]);
  });

  it("merges NFD and NFC paths under the NFC key", () => {
    const payload = payloadFor(readFixture("unicode-nfc", fixtureRoot));
    const [fact] = payload.facts;

    expect(payload.facts).toHaveLength(1);
    expect(fact.kind).toBe("file.modified");
    expect(fact.key).toBe("café.txt");
    expect(fact.key).toBe(fact.key.normalize("NFC"));
    expect(fact.attrs.edits).toBe(2);
  });

  it("retains external paths only as opaque scope ids and basenames", () => {
    const fixture = readFixture("paths-outside", fixtureRoot);
    const payload = payloadFor(fixture);
    const externalFacts = payload.facts.filter((fact) => fact.scope === "external");
    const serialized = JSON.stringify(payload);

    expect(payload.path_base).toBe("cwd");
    expect(externalFacts.length).toBeGreaterThan(0);
    expect(payload.counters.external_path_count).toBe(externalFacts.length);
    expect(externalFacts.map((fact) => fact.key).sort()).toEqual([
      "31ff783316b5:notes.md",
      "88148e1718a9:report.md",
    ]);
    for (const fact of externalFacts) expect(fact.key).toMatch(/^[0-9a-f]+:[^/]+$/);

    for (const hostPath of [
      "/outside/private/report.md",
      "/other/private/notes.md",
      fixture.metadata.cwd,
    ]) {
      expect(serialized).not.toContain(hostPath);
    }
  });

  it("keeps both sides of an error cycle and records the fixer", () => {
    const payload = payloadFor(readFixture("error-cycle", fixtureRoot));
    const raised = payload.facts.find((fact) => fact.kind === "error.raised");
    const fixed = payload.facts.find((fact) => fact.kind === "error.fixed");

    expect(raised).toBeDefined();
    expect(fixed).toBeDefined();
    expect(raised?.key).toBe("permission:permission denied");
    expect(fixed?.key).toBe(raised?.key);
    expect(fixed?.attrs.fixed_by).toBe("npm test");
  });

  it("counts unknown tools as incomplete coverage without degrading", () => {
    const result = resultFor(readFixture("unknown-tool", fixtureRoot));

    expect(result.counters.coverage_ppm).toBeLessThan(1_000_000);
    expect(result.counters.unmapped_tool_calls).toBeGreaterThanOrEqual(1);
    expect(result.degraded).toEqual([]);
  });

  it("distinguishes CRLF evidence bytes while preserving extracted facts", () => {
    const fixture = readFixture("crlf", fixtureRoot);
    const transcriptText = textDecoder.decode(fixture.transcriptBytes);
    expect(transcriptText).toContain("\r\n");
    expect(fixture.transcriptBytes.at(-1)).not.toBe(0x0a);
    expect(fixture.transcriptBytes.at(-1)).not.toBe(0x0d);

    const lfBytes = textEncoder.encode(transcriptText.replaceAll("\r\n", "\n"));
    const lfEvents = parseTranscript(lfBytes);
    const crlfPayload = payloadFor(fixture);
    const lfPayload = extractPayload(lfEvents, configForFixture(fixture));

    expect(crlfPayload.facts[0].evidence[0].sha256).toBe(lineHash(fixture.events[0].rawLine));
    expect(lfPayload.facts[0].evidence[0].sha256).toBe(lineHash(lfEvents[0].rawLine));
    expect(crlfPayload.facts[0].evidence[0].sha256).not.toBe(lfPayload.facts[0].evidence[0].sha256);
    expect(factsWithoutEvidenceHashes(crlfPayload.facts)).toEqual(
      factsWithoutEvidenceHashes(lfPayload.facts),
    );
  });

  it("truncates the huge command to complete words at the 512-code-point cap", () => {
    const fixture = readFixture("huge-command", fixtureRoot);
    const event = fixture.events[0];
    if (event.type !== "tool" || event.command === undefined) throw new TypeError("huge-command fixture is not a command");
    const payload = payloadFor(fixture);
    const fact = payload.facts.find((item) => item.kind === "cmd.run");
    if (fact === undefined) throw new TypeError("huge-command fixture produced no command fact");

    expect(textEncoder.encode(event.command).byteLength).toBe(2048);
    expect(fact.key.length).toBeLessThanOrEqual(512);
    expect(fact.key.endsWith("…")).toBe(true);
    const normalizedPrefix = fact.key.slice(0, -1);
    const normalizedCommand = event.command.trim().replace(/[ \t]+/g, " ");
    expect(normalizedCommand.startsWith(normalizedPrefix)).toBe(true);
    expect(normalizedCommand[normalizedPrefix.length]).toBe(" ");
    expect(normalizedPrefix.endsWith(" ")).toBe(false);

    expect(fact.snippet.startsWith("bash ")).toBe(true);
    const snippetCommand = fact.snippet.slice("bash ".length);
    expect(snippetCommand.length).toBeLessThanOrEqual(512);
    expect(snippetCommand.endsWith("…")).toBe(true);
    expect(snippetCommand).toBe(fact.key);
  });

  it("asserts clock-env targets single-edit without separate expectations", () => {
    const clockFixture = readFixture("clock-env", fixtureRoot);
    const targetFixture = readFixture("single-edit", fixtureRoot);
    const clockMetadata = clockFixture.metadata as VectorFixture["metadata"] & {
      readonly perturbations?: readonly string[];
    };
    const clockPayload = payloadFor(clockFixture);
    const targetPayload = payloadFor(targetFixture);

    expect(clockMetadata.equivalentTo).toBe("single-edit");
    expect(clockMetadata.perturbations).toEqual([
      "TZ",
      "LANG",
      "LC_ALL",
      "HOME",
      "cwd",
      "clock",
      "hostname",
      "os",
    ]);
    expect(clockPayload).toEqual(targetPayload);
    expect(canonicalize(clockPayload)).toBe(canonicalize(targetPayload));
    expect(payloadHash(clockPayload)).toBe(payloadHash(targetPayload));
    expect(payloadHash(clockPayload)).toBe(expectedHash("single-edit", fixtureRoot));
    expect(expectedHash("clock-env", fixtureRoot)).toBe(expectedHash("single-edit", fixtureRoot));
  });
});
