/**
 * The adapter framework, exercised through a test-only adapter.
 *
 * The fake adapter (`test/fixtures/adapters/fake.json` plus the mapper below) is deliberate: the
 * framework's claims are about *any* adapter, and a claim tested only through the Claude adapter
 * would be a claim about Claude. What is asserted here is what the framework promises a caller:
 *
 * - a definition plus a mapper produces facts, counters, and health;
 * - a declaration that no longer covers the transcript is stamped `schema-drift` on the result a
 *   caller renders, while extraction continues;
 * - a tool name the vocabulary does not contain is a *counted miss* — it lowers coverage and adds
 *   no degraded state, which is a different failure from drift and must stay one;
 * - a definition that cannot be parsed is reported and does not take a working one down with it;
 * - the shipped Claude adapter, driven through the framework, still matches the expectations
 *   committed with its fixtures and the payload hash published in `docs/demo/`.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { declaredShape, detectDrift, transcriptShape, verifyFixtures } from "../src/adapters/drift.js";
import { claudeDefinition, readClaudeTranscript } from "../src/adapters/mappers.js";
import { AdapterRegistry, buildExtractConfig, extractWithAdapter, loadAdapterDefinition, parseAdapterDefinition } from "../src/adapters/registry.js";
import type { AdapterDefinition, AdapterDiagnostic, AdapterMapper, AdapterParseResult } from "../src/adapters/registry.js";
import { renderPack } from "../src/core/pack.js";
import { payloadHash } from "../src/core/hash.js";
import type { NormalizedEvent, NormalizedToolEvent } from "../src/core/types.js";

const repositoryRoot = process.cwd();
const adaptersDirectory = join(repositoryRoot, "test", "fixtures", "adapters");
const fakeTranscriptBytes = new Uint8Array(readFileSync(join(adaptersDirectory, "fake-transcript.jsonl")));

const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

interface FakeRecord {
  readonly line: number;
  readonly bytes: Uint8Array;
  readonly value: Record<string, unknown> | null;
}

/**
 * Physical lines of the fake transcript, parsed tolerantly.
 *
 * The fake format is `{"type":"session"|"note"|"tool_call"|"tool_result", …}` — the smallest
 * shape that still exercises pairing, identity, and the vocabulary tables.
 */
function fakeRecords(bytes: Uint8Array): FakeRecord[] {
  const decoder = new TextDecoder("utf-8");
  const records: FakeRecord[] = [];
  let start = 0;
  let line = 1;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 0x0a) continue;
    const lineBytes = bytes.subarray(start, index);
    start = index + 1;
    if (lineBytes.length > 0) {
      let value: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(decoder.decode(lineBytes));
        value = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      } catch {
        value = null;
      }
      records.push({ line, bytes: lineBytes, value });
    }
    line += 1;
  }
  return records;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The fake mapper: pairing by id, identity from the transcript, everything vocabulary-shaped from
 * the definition. Written to the same contract as the Claude mapper — a refused extraction input
 * throws, nothing else does.
 */
const FAKE_MAPPER: AdapterMapper = (bytes, definition) => {
  const diagnostics: AdapterDiagnostic[] = [];
  const records = fakeRecords(bytes);
  const calls = new Map<string, { readonly line: number; readonly bytes: Uint8Array; readonly name: string; readonly path: string | null; readonly command: string | null }>();
  const results = new Map<string, { readonly line: number; readonly bytes: Uint8Array; readonly ok: boolean; readonly error: string | null }>();
  const notes: Array<{ readonly line: number; readonly bytes: Uint8Array; readonly text: string }> = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;

  for (const record of records) {
    const value = record.value;
    if (value === null) {
      diagnostics.push({ line: record.line, code: "malformed-record", detail: "json" });
      continue;
    }
    const type = asString(value.type);
    if (type === "session") {
      sessionId = asString(value.id);
      cwd = asString(value.cwd);
      continue;
    }
    if (type === "note") {
      const text = asString(value.text);
      if (text === null) diagnostics.push({ line: record.line, code: "record-shape", detail: "note-text" });
      else notes.push({ line: record.line, bytes: record.bytes, text });
      continue;
    }
    if (type === "tool_call") {
      const id = asString(value.id);
      const name = asString(value.name);
      if (id === null || name === null) {
        diagnostics.push({ line: record.line, code: "record-shape", detail: "tool-call" });
        continue;
      }
      calls.set(id, { line: record.line, bytes: record.bytes, name, path: asString(value.path), command: asString(value.command) });
      continue;
    }
    if (type === "tool_result") {
      const id = asString(value.for);
      if (id === null) {
        diagnostics.push({ line: record.line, code: "record-shape", detail: "tool-result" });
        continue;
      }
      results.set(id, { line: record.line, bytes: record.bytes, ok: value.ok !== false, error: asString(value.error) });
      continue;
    }
    diagnostics.push({ line: record.line, code: "unknown-record-type", detail: type !== null && SAFE_TOKEN.test(type) ? type : "<other>" });
  }

  const events: NormalizedEvent[] = [];
  for (const note of notes) events.push({ type: "user", entry: note.line - 1, line: note.line, rawLine: note.bytes, timestamp: null, text: note.text });
  for (const [id, call] of calls) {
    const result = results.get(id);
    const event: NormalizedToolEvent = {
      type: "tool",
      entry: call.line - 1,
      line: call.line,
      rawLine: call.bytes,
      timestamp: null,
      toolCallId: id,
      toolName: call.name,
      ...(call.path === null ? {} : { path: call.path }),
      ...(call.command === null ? {} : { command: call.command }),
      isError: result !== undefined && !result.ok,
      ...(result !== undefined && !result.ok && result.error !== null ? { errorMessage: result.error } : {}),
      ...(result === undefined ? { resultObserved: false } : { sources: [{ line: result.line, rawLine: result.bytes }] }),
    };
    events.push(event);
  }
  events.sort((left, right) => left.entry - right.entry);

  if (cwd === null) throw new TypeError("the fake transcript records no session cwd");
  const toolNames = [...new Set([...calls.values()].map((call) => call.name))].sort();
  const parse: AdapterParseResult = {
    events,
    diagnostics,
    session: { sessionId, cwd, version: null },
    toolNames,
    recordCount: records.length,
    conversationRecords: notes.length + calls.size,
    toolCalls: calls.size,
    toolResults: results.size,
  };
  return {
    parse,
    config: buildExtractConfig(definition, { cwd, repoRoot: null, pathBase: "cwd", scopeRoots: [], toolNames }),
  };
};

function fakeDefinition(): AdapterDefinition {
  const outcome = loadAdapterDefinition(join(adaptersDirectory, "fake.json"));
  if (!outcome.ok) throw new TypeError(`the fake adapter definition did not load: ${outcome.problems.join("; ")}`);
  return outcome.definition;
}

/** The same definition with a deliberate edit, re-validated the way a human's edit would be. */
function mutatedDefinition(mutate: (value: Record<string, unknown>) => void): AdapterDefinition {
  const value = JSON.parse(readFileSync(join(adaptersDirectory, "fake.json"), "utf8")) as Record<string, unknown>;
  mutate(value);
  const parsed = parseAdapterDefinition(value);
  if (!parsed.ok) throw new TypeError(`the mutated definition is invalid: ${parsed.problems.join("; ")}`);
  return parsed.definition;
}

/** The fake transcript with records appended, as a live session would grow it. */
function withRecords(extra: readonly object[]): Uint8Array {
  const text = new TextDecoder().decode(fakeTranscriptBytes);
  return new TextEncoder().encode(`${text}\n${extra.map((record) => JSON.stringify(record)).join("\n")}`);
}

describe("adapter framework", () => {
  it("drives a definition and a mapper end to end", () => {
    const run = extractWithAdapter(fakeDefinition(), FAKE_MAPPER, fakeTranscriptBytes);

    expect(run.config.adapterId).toBe("generic");
    expect(run.parse.session).toEqual({ sessionId: "fake-session", cwd: "/fake/repo", version: null });
    expect(run.parse.toolNames).toEqual(["Bash", "Read", "Write"]);
    expect(run.payload.path_base).toBe("cwd");
    expect(run.payload.facts.map((fact) => `${fact.kind} ${fact.key}`).sort()).toEqual([
      "cmd.failed npm run check",
      "decision.stated We must keep the fake adapter free of new dependencies.",
      "error.raised unknown:npm error code ENOENT",
      "file.modified fake/notes.md",
      "file.read fake/notes.md",
    ]);
    expect(run.degraded).toEqual([]);
    expect(run.drift).toEqual({ drifted: false, unknown: [] });
    expect(run.coverage).toEqual({
      source_tool_calls: 3,
      unmapped_tool_calls: 0,
      coverage_ppm: 1_000_000,
      unmapped_by_tool: {},
    });
  });

  it("stamps schema-drift when the declaration stops covering the transcript", () => {
    // A human narrowing the vocabulary — the shape the fixture recorded is dropped too, because
    // `verifyFixtures` requires every recorded fixture shape to stay declared.
    const definition = mutatedDefinition((value) => {
      const transcript = value.transcript as { records: { conversational: string[] } };
      transcript.records.conversational = ["note"];
    });
    const run = extractWithAdapter(definition, FAKE_MAPPER, fakeTranscriptBytes);

    expect(run.drift).toEqual({ drifted: true, unknown: ["record:session", "record:tool_call", "record:tool_result"] });
    expect(run.degraded).toEqual(["schema-drift"]);
    // Extraction continues: the adapter does not stop on drift, it reports it — and the stamp is
    // on what a caller renders, not in a log line nobody reads.
    expect(run.payload.counters.facts).toBeGreaterThan(0);
    expect(renderPack(run.payload, { degraded: run.degraded })).toContain("Status: degraded: schema-drift");
  });

  it("stamps schema-drift when the transcript gains a record shape the adapter never declared", () => {
    const run = extractWithAdapter(fakeDefinition(), FAKE_MAPPER, withRecords([{ type: "brand-new-shape", payload: "x" }]));

    expect(run.drift.unknown).toEqual(["record:brand-new-shape"]);
    expect(run.degraded).toEqual(["schema-drift"]);
  });

  it("counts an unmapped tool name without treating it as drift", () => {
    const run = extractWithAdapter(
      fakeDefinition(),
      FAKE_MAPPER,
      withRecords([
        { type: "tool_call", id: "f4", name: "QuantumRefactor", path: "fake/later.md" },
        { type: "tool_result", for: "f4", ok: true },
      ]),
    );

    expect(run.payload.counters.source_tool_calls).toBe(4);
    expect(run.payload.counters.unmapped_tool_calls).toBe(1);
    expect(run.payload.counters.coverage_ppm).toBe(750_000);
    expect(run.coverage.unmapped_by_tool).toEqual({ QuantumRefactor: 1 });
    // The binding distinction: a vocabulary miss is counted, never degraded.
    expect(run.degraded).toEqual([]);
    expect(run.drift.drifted).toBe(false);
  });

  it("treats a tool name borrowed from Object.prototype as unmapped, not as declared", () => {
    const run = extractWithAdapter(
      fakeDefinition(),
      FAKE_MAPPER,
      withRecords([
        { type: "tool_call", id: "f5", name: "constructor", path: "fake/prototype.md" },
        { type: "tool_result", for: "f5", ok: true },
      ]),
    );

    expect(run.payload.counters.unmapped_tool_calls).toBe(1);
    expect(run.coverage.unmapped_by_tool).toEqual({ constructor: 1 });
    expect(run.payload.facts.some((fact) => fact.key === "fake/prototype.md")).toBe(false);
  });

  it("reports an unusable definition as degraded without disabling a working one", () => {
    const directory = mkdtempSync(join(tmpdir(), "dcompress-adapters-"));
    try {
      const valid = readFileSync(join(adaptersDirectory, "fake.json"), "utf8");
      writeFileSync(join(directory, "fake.json"), valid);
      writeFileSync(
        join(directory, "wrong-kind.json"),
        JSON.stringify({ ...(JSON.parse(valid) as Record<string, unknown>), tools: { exact: { Write: "not-a-kind" }, prefixes: [] } }),
      );
      writeFileSync(join(directory, "truncated.json"), '{"adapter": "claude",');
      writeFileSync(
        join(directory, "bad-record-name.json"),
        JSON.stringify({
          ...(JSON.parse(valid) as Record<string, unknown>),
          transcript: { format: "jsonl", records: { conversational: ["tool call"], non_conversational: [] } },
        }),
      );

      const registry = AdapterRegistry.load(directory);

      expect(registry.definitions().map((definition) => definition.adapter)).toEqual(["generic"]);
      expect(registry.failures().map((failure) => basename(failure.path))).toEqual(["bad-record-name.json", "truncated.json", "wrong-kind.json"]);
      expect(registry.degraded()).toEqual(["schema-drift"]);
      const problems = registry.failures().flatMap((failure) => failure.problems).join(" ");
      expect(problems).toContain("tools.exact.Write");
      // A record name that cannot become a shape token would silently widen what drift accepts.
      expect(problems).toContain("transcript.records.conversational");

      const definition = registry.get("generic");
      if (definition === null) throw new TypeError("the valid definition beside the broken ones must still load");
      const run = extractWithAdapter(definition, FAKE_MAPPER, fakeTranscriptBytes);
      expect(run.degraded).toEqual([]);
      expect(run.payload.counters.facts).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads the transcript shape without asking the mapper", () => {
    // The check is independent by construction: a mapper that silently ignores a record type
    // cannot suppress it, because the framework never consults the mapper for this.
    expect(transcriptShape(fakeTranscriptBytes)).toEqual(["record:note", "record:session", "record:tool_call", "record:tool_result"]);
    expect(transcriptShape(withRecords([{ type: "brand-new-shape" }]))).toContain("record:brand-new-shape");
    expect(declaredShape(fakeDefinition())).toEqual(["record:note", "record:session", "record:tool_call", "record:tool_result"]);
    expect(detectDrift(fakeDefinition(), new Uint8Array(0))).toEqual({ drifted: false, unknown: [] });
  });
});

describe("the Claude adapter through the framework", () => {
  const fixtures = ["slice-0001", "post-compact-0001"] as const;

  it.each(fixtures)("matches the committed expectations for %s", (name) => {
    const directory = join(repositoryRoot, "test", "fixtures", "claude", name);
    const bytes = new Uint8Array(readFileSync(join(directory, "transcript.jsonl")));
    const manifest = JSON.parse(readFileSync(join(directory, "fixture.manifest.json"), "utf8")) as {
      readonly expected: { readonly degraded: readonly string[]; readonly facts: number; readonly factsByKind: Record<string, number>; readonly toolCalls: number; readonly parseDiagnostics: number };
    };

    const run = readClaudeTranscript(bytes);

    expect(run.degraded).toEqual(manifest.expected.degraded);
    expect(run.parse.diagnostics).toHaveLength(manifest.expected.parseDiagnostics);
    expect(run.parse.toolCalls).toBe(manifest.expected.toolCalls);
    expect(run.payload.counters.facts).toBe(manifest.expected.facts);
    expect(run.payload.counters.by_kind).toEqual(manifest.expected.factsByKind);
    expect(run.payload.counters.unmapped_tool_calls).toBe(0);
    expect(run.coverage.unmapped_by_tool).toEqual({});
    expect(run.drift).toEqual({ drifted: false, unknown: [] });
  });

  it("publishes the payload hash the demo document records", () => {
    // `docs/demo/claude-slice-0001.md` quotes the hash of the payload its command produced, and
    // `demo.spec.ts` asserts that document against the CLI. Asserting the same hash through the
    // framework's own entry point is what makes "byte-identical through the framework" a claim
    // about the framework rather than about the CLI.
    const demo = readFileSync(join(repositoryRoot, "docs", "demo", "claude-slice-0001.md"), "utf8");
    const documented = /\| Payload hash \(in the stderr report and the `--json` output\) \| `(sha256:[0-9a-f]{64})` \|/.exec(demo);
    const bytes = new Uint8Array(readFileSync(join(repositoryRoot, "test", "fixtures", "claude", "slice-0001", "transcript.jsonl")));

    expect(documented).not.toBeNull();
    expect(payloadHash(readClaudeTranscript(bytes).payload)).toBe(documented?.[1]);
  });

  it("keeps the shipped definition anchored to its verified fixtures and the documented hook surface", () => {
    const definition = claudeDefinition();

    expect(definition.last_verified_version).toBe("2.1.238");
    expect(definition.verified_at).toBe("2026-09-13");
    expect(verifyFixtures(definition, repositoryRoot)).toEqual([]);
    for (const fixture of definition.fixtures) {
      const bytes = readFileSync(join(repositoryRoot, fixture.path));
      expect(fixture.sha256).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    }
    // ADAPTER-SPEC §2: the installed hook set is SessionStart and PostCompact; PreCompact is the
    // development integration that captures a session before its history is dropped.
    expect(definition.hooks.map((hook) => hook.event).sort()).toEqual(["PostCompact", "SessionStart"]);
    expect(definition.event_map.filter((route) => route.registered).map((route) => route.hook).sort()).toEqual(["PostCompact", "SessionStart"]);
    expect(definition.event_map.find((route) => route.hook === "PreCompact")?.registered).toBe(false);
    expect(definition.tools.exact.Bash).toBe("command");
    expect(definition.tools.prefixes).toEqual([{ prefix: "mcp__", kind: "ignored" }]);
  });
});