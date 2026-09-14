import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ClaudeTranscriptRefusal,
  claudeExtractConfig,
  claudeToolKinds,
  parseClaudeTranscript,
} from "../src/adapters/claude.js";
import { claudeDefinition } from "../src/adapters/mappers.js";
import { parsePreviewArgs, preview, run, UsageError, type CliIo } from "../src/cli.js";
import { canonicalize } from "../src/core/canonical.js";
import { extractPayload } from "../src/core/extract/index.js";
import { lineHash, payloadHash } from "../src/core/hash.js";
import { renderPack } from "../src/core/pack.js";
import type { DegradedState, NormalizedToolEvent, PackOptions } from "../src/core/types.js";

/**
 * The shipped adapter definition, as the whole suite must see it: version, tool vocabulary, and
 * record vocabulary are all data now, so these assertions are about `adapters/claude.json`
 * driving the mapper rather than about constants in the mapper's source.
 */
const definition = claudeDefinition();
const CLAUDE_OBSERVED_VERSION = definition.last_verified_version;
const CLAUDE_TOOL_KINDS = definition.tools.exact;

const fixtureDirectory = join(process.cwd(), "test", "fixtures", "claude", "slice-0001");
const fixturePath = join(fixtureDirectory, "transcript.jsonl");
const fixtureBytes = new Uint8Array(readFileSync(fixturePath));
const postCompactFixtureDirectory = join(process.cwd(), "test", "fixtures", "claude", "post-compact-0001");
const postCompactFixturePath = join(postCompactFixtureDirectory, "transcript.jsonl");
const postCompactFixtureBytes = new Uint8Array(readFileSync(postCompactFixturePath));
const POST_COMPACT_BOUNDARY_SENTINEL = "SYNTHETIC_COMPACT_BOUNDARY_SENTINEL";
const POST_COMPACT_SUMMARY_SENTINEL = "SYNTHETIC_COMPACT_SUMMARY_SENTINEL";
const textEncoder = new TextEncoder();

function source(lines: readonly object[]): Uint8Array {
  return textEncoder.encode(lines.map((line) => JSON.stringify(line)).join("\n"));
}

/** An assistant/user pair, so pairing tests never depend on adjacency. */
function pair(
  id: string,
  name: string,
  input: object,
  result: object,
  options: { readonly isError?: boolean; readonly gap?: object } = {},
): object[] {
  const assistant = {
    type: "assistant",
    uuid: `${id}-a`,
    parentUuid: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    cwd: "/fixture/repo",
    sessionId: "session",
    version: CLAUDE_OBSERVED_VERSION,
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input, caller: { type: "direct" } }] },
  };
  const user = {
    type: "user",
    uuid: `${id}-r`,
    parentUuid: `${id}-a`,
    timestamp: "2026-01-01T00:00:02.000Z",
    cwd: "/fixture/repo",
    sessionId: "session",
    version: CLAUDE_OBSERVED_VERSION,
    sourceToolAssistantUUID: `${id}-a`,
    message: {
      role: "user",
      content: [
        {
          tool_use_id: id,
          type: "tool_result",
          content: options.isError === true ? `Error: ${JSON.stringify(result)}` : "ok",
          ...(options.isError === true ? { is_error: true } : {}),
        },
      ],
    },
    ...(options.isError === true ? { toolUseResult: `Error: ${JSON.stringify(result)}` } : { toolUseResult: result }),
  };
  return options.gap === undefined ? [assistant, user] : [assistant, options.gap, user];
}

function eventsFor(bytes: Uint8Array) {
  return parseClaudeTranscript(bytes, definition);
}

const textDecoder = new TextDecoder("utf-8");

/** Physical lines including their terminator, mirroring the fixture's LF rule. */
function physicalLines(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    lines.push(bytes.slice(start, index + 1));
    start = index + 1;
  }
  if (start < bytes.length) lines.push(bytes.slice(start));
  return lines;
}

describe("claude transcript fixture", () => {
  it("parses every retained record without a diagnostic", () => {
    const parse = eventsFor(fixtureBytes);

    expect(parse.diagnostics).toEqual([]);
    expect(parse.session).toEqual({ sessionId: "fixture-session-0001", cwd: "/fixture/repo", version: "2.1.238" });
    expect(parse.recordCount).toBe(18);
    expect(parse.toolCalls).toBe(7);
    expect(parse.toolResults).toBe(7);
    expect(parse.toolNames).toEqual(["Bash", "Edit", "Read", "Write"]);
  });

  it("does not end with a newline, so evidence hashes cover the final record", () => {
    expect(fixtureBytes[fixtureBytes.length - 1]).not.toBe(0x0a);
    const lines = physicalLines(fixtureBytes);
    expect(lines).toHaveLength(20);
    // The fixture's final record (line 20) is assistant prose, which yields no event; the last
    // event therefore comes from line 18, and it must still carry that line's exact bytes.
    const parse = eventsFor(fixtureBytes);
    const last = parse.events.at(-1);
    if (last === undefined) throw new TypeError("fixture produced no events");
    expect(last.line).toBe(18);
    expect(last.rawLine).toEqual(lines[17]);
    if (typeof last.rawLine === "string") throw new TypeError("the mapper must expose physical line bytes");
    expect(textDecoder.decode(last.rawLine).endsWith("\n")).toBe(true);
  });

  it("pairs tool calls with results across the records between them", () => {
    const parse = eventsFor(fixtureBytes);
    const tools = parse.events.filter((event): event is NormalizedToolEvent => event.type === "tool");
    const read = tools.find((event) => event.toolName === "Read");
    const failed = tools.find((event) => event.isError);

    expect(tools).toHaveLength(7);
    // The Read call is physical line 5; its result is line 6 after intervening attachment records.
    expect(read?.line).toBe(5);
    // The mapper forwards the tool's own path verbatim: normalization belongs to extraction,
    // so an unnormalized path is still observable here.
    expect(read?.path).toBe("/fixture/repo/notes.md");
    expect(read?.isError).toBe(false);
    expect(failed?.toolName).toBe("Bash");
    expect(failed?.command).toBe("npm run check");
    expect(failed?.intent).toBe("Run npm check script (expected to fail, no package.json yet)");
    expect(failed?.errorMessage).toContain("ENOENT");
  });

  it("extracts the fixture into the declared payload", () => {
    const parse = eventsFor(fixtureBytes);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));

    expect(payload.path_base).toBe("cwd");
    // Fact order is core's; assert the set and the anchored keys rather than inventing an order.
    expect(payload.facts.map((fact) => fact.kind).sort()).toEqual([
      "cmd.failed",
      "cmd.run",
      "cmd.run",
      "decision.stated",
      "error.fixed",
      "error.raised",
      "file.modified",
      "file.modified",
      "file.read",
    ]);
    expect(payload.facts.map((fact) => `${fact.kind} ${fact.key}`).sort()).toEqual([
      "cmd.failed npm run check",
      "cmd.run ls -la .",
      "cmd.run npm run check",
      "decision.stated We must keep this helper dependency-free.",
      // `normalizeErrorMessage` collapses the trailing newline to a single space before the
      // 200-character cap, so both signatures end in ", ".
      "error.fixed unknown:Exit code N npm error code ENOENT npm error syscall open npm error path package.json npm error errno -2 npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, ",
      "error.raised unknown:Exit code N npm error code ENOENT npm error syscall open npm error path package.json npm error errno -2 npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, ",
      "file.modified package.json",
      "file.modified src/util.ts",
      "file.read notes.md",
    ].sort());
    expect(payload.counters).toEqual({
      facts: 9,
      by_kind: {
        "cmd.failed": 1,
        "cmd.run": 2,
        "decision.stated": 1,
        "error.fixed": 1,
        "error.raised": 1,
        "file.modified": 2,
        "file.read": 1,
      },
      source_entries: 8,
      source_tool_calls: 7,
      unmapped_tool_calls: 0,
      coverage_ppm: 1_000_000,
      external_path_count: 0,
    });
  });

  it("keeps evidence 1-based, raw, and path-free", () => {
    const parse = eventsFor(fixtureBytes);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));
    const modified = payload.facts.find((fact) => fact.kind === "file.modified" && fact.key === "src/util.ts");

    // The Write call (line 10) and its result (line 11), then the Edit call (line 18) and its
    // result (line 19): both physical lines of each non-adjacent pair back the merged fact.
    expect(modified?.evidence.map((entry) => entry.line)).toEqual([10, 11, 18, 19]);
    for (const fact of payload.facts) {
      for (const entry of fact.evidence) {
        expect(Object.keys(entry).sort()).toEqual(["line", "sha256"]);
        expect(entry.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    }
    expect(canonicalize(payload)).not.toContain("/fixture/repo");
    expect(canonicalize(payload)).not.toContain("/tmp/");
  });

  it("backs a non-adjacent call with the exact bytes of both its physical lines", () => {
    const parse = eventsFor(fixtureBytes);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));
    const lines = physicalLines(fixtureBytes);
    const failed = payload.facts.find((fact) => fact.kind === "cmd.failed");
    const raised = payload.facts.find((fact) => fact.kind === "error.raised");

    // The failed Bash call is physical line 12; its `is_error` result is line 13.
    expect(failed?.evidence.map((entry) => entry.line)).toEqual([12, 13]);
    expect(failed?.evidence[0].sha256).toBe(lineHash(lines[11]));
    expect(failed?.evidence[1].sha256).toBe(lineHash(lines[12]));
    expect(failed?.evidence[1].sha256).not.toBe(failed?.evidence[0].sha256);
    // The error fact is carried by the result line, so it must cite that line's bytes.
    expect(raised?.evidence.map((entry) => entry.line)).toEqual([12, 13]);
    expect(raised?.evidence[1].sha256).toBe(lineHash(lines[12]));

    const resultLine = textDecoder.decode(lines[12]);
    expect(resultLine).toContain('"is_error":true');
    expect(resultLine).toContain("ENOENT");
    // The call line, by contrast, contains no error data at all.
    expect(textDecoder.decode(lines[11])).not.toContain("is_error");
  });

  it("merges a written-then-edited file into one fact with both tools and both evidence lines", () => {
    const parse = eventsFor(fixtureBytes);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));
    const modified = payload.facts.find((fact) => fact.kind === "file.modified" && fact.key === "src/util.ts");

    expect(modified?.attrs).toEqual({ edits: 2, tools: ["Edit", "Write"] });
    expect(modified?.scope).toBe("cwd");
    expect(modified?.at.entry).toBe(9);
  });

  it("reports the error cycle raised and fixed with the fixing command", () => {
    const parse = eventsFor(fixtureBytes);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));
    const raised = payload.facts.find((fact) => fact.kind === "error.raised");
    const fixed = payload.facts.find((fact) => fact.kind === "error.fixed");

    expect(raised?.key).toBe(fixed?.key);
    expect(fixed?.attrs.fixed_by).toBe("npm run check");
    expect(raised?.attrs.class).toBe("unknown");
  });

  it("surfaces the decision cue from the user turn only", () => {
    const parse = eventsFor(fixtureBytes);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));
    const decision = payload.facts.find((fact) => fact.kind === "decision.stated");

    expect(decision?.attrs.cue).toBe("we must");
    expect(decision?.at.entry).toBe(2);
  });
});

describe("claude post-compaction fixture", () => {
  it("recognizes the boundary and summary records without drift or payload prose", () => {
    const parse = eventsFor(postCompactFixtureBytes);
    const fixtureManifest = JSON.parse(readFileSync(join(postCompactFixtureDirectory, "fixture.manifest.json"), "utf8")) as {
      readonly transcriptBytes: number;
      readonly sanitizedSha256: string;
      readonly lineEnding: string;
    };
    expect(fixtureManifest.transcriptBytes).toBe(postCompactFixtureBytes.byteLength);
    expect(fixtureManifest.sanitizedSha256).toBe(`sha256:${createHash("sha256").update(postCompactFixtureBytes).digest("hex")}`);
    expect(fixtureManifest.lineEnding).toBe("LF, no trailing newline (SCHEMA §10 fixture rule)");
    expect(postCompactFixtureBytes.at(-1)).not.toBe(0x0a);
    expect(parse.diagnostics).toEqual([]);
    expect(parse.session).toEqual({ sessionId: "fixture-post-compact", cwd: "/fixture/repo", version: "2.1.270" });
    expect(parse.recordCount).toBe(6);
    expect(parse.toolCalls).toBe(2);
    expect(parse.toolResults).toBe(2);
    expect(parse.events.filter((event) => event.type === "tool")).toHaveLength(2);

    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));
    const eventText = JSON.stringify(parse.events);
    expect(eventText).not.toContain(POST_COMPACT_BOUNDARY_SENTINEL);
    expect(eventText).not.toContain(POST_COMPACT_SUMMARY_SENTINEL);
    expect(payload.facts.map((fact) => `${fact.kind} ${fact.key}`).sort()).toEqual([
      "file.modified after-compact.txt",
      "file.read before-compact.txt",
    ]);
    expect(canonicalize(payload)).not.toContain("compact_boundary");
    expect(canonicalize(payload)).not.toContain("isCompactSummary");
    expect(canonicalize(payload)).not.toContain("preTokens");
    expect(canonicalize(payload)).not.toContain("2026-01-01T00:00:03.000Z");
    expect(canonicalize(payload)).not.toContain("2026-01-01T00:00:04.000Z");
  });

  it("keeps the CLI health clean for a recognized post-compaction transcript", () => {
    const result = preview({ transcript: postCompactFixturePath, pack: {} });

    expect(result.degraded).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.pack).toContain("\nStatus: ok\n");
    expect(result.report).toContain("health: ok");
    expect(result.pack).not.toContain(POST_COMPACT_BOUNDARY_SENTINEL);
    expect(result.pack).not.toContain(POST_COMPACT_SUMMARY_SENTINEL);
    expect(result.report).not.toContain("schema-drift");
    expect(result.report).not.toContain("extraction-empty");
    expect(result.report).not.toContain(POST_COMPACT_BOUNDARY_SENTINEL);
    expect(result.report).not.toContain(POST_COMPACT_SUMMARY_SENTINEL);
    expect(JSON.stringify(result.diagnostics)).not.toContain(POST_COMPACT_SUMMARY_SENTINEL);
  });
});

describe("claude mapper edge cases", () => {
  it("refuses to normalize paths when the transcript records no cwd", () => {
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, sessionId: "s", message: { role: "assistant", content: [] } },
    ]);
    const parse = eventsFor(bytes);

    expect(() => claudeExtractConfig(parse, definition)).toThrow(ClaudeTranscriptRefusal);
    expect(parse.session.cwd).toBeNull();
  });

  it("treats only is_error true as failure", () => {
    const bytes = source([
      ...pair("c1", "Bash", { command: "a" }, { stdout: "" }),
      ...pair("c2", "Bash", { command: "b" }, { stderr: "boom" }, { isError: true }),
    ]);
    const tools = eventsFor(bytes).events.filter((event): event is NormalizedToolEvent => event.type === "tool");

    expect(tools.map((event) => event.isError)).toEqual([false, true]);
    expect(tools[0].errorMessage).toBeUndefined();
    expect(tools[1].errorMessage).toContain('"stderr":"boom"');
  });

  it("marks an unknown top-level record type as schema drift instead of guessing", () => {
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } },
      { type: "totally-new-record", uuid: "b", timestamp: null },
    ]);
    const parse = eventsFor(bytes);

    expect(parse.diagnostics).toEqual([{ line: 2, code: "unknown-record-type", detail: "totally-new-record" }]);
    expect(parse.events).toEqual([]);
  });

  it("keeps a malformed compact boundary as schema drift instead of guessing", () => {
    const bytes = source([
      { type: "system", subtype: "compact_boundary", uuid: "malformed-boundary", sessionId: "wrong", cwd: "/wrong", version: "wrong", content: "invalid", compactMetadata: null },
      { type: "system", subtype: "compact_boundary", uuid: "valid-boundary", sessionId: "s", cwd: "/fixture/repo", version: "2.1.270", content: "valid", compactMetadata: { trigger: "manual" } },
    ]);
    const parse = eventsFor(bytes);

    expect(parse.session).toEqual({ sessionId: "s", cwd: "/fixture/repo", version: "2.1.270" });
    expect(parse.recordCount).toBe(2);
    expect(() => claudeExtractConfig(parse, definition)).not.toThrow();
    expect(parse.diagnostics).toEqual([{ line: 1, code: "conversational-content-not-text", detail: "system" }]);
    expect(parse.events).toEqual([]);
  });

  it("uses compact-boundary identity when it is the sole transcript context", () => {
    const bytes = source([
      { type: "system", subtype: "compact_boundary", sessionId: "boundary-only", cwd: "/fixture/repo", version: "2.1.270", content: POST_COMPACT_BOUNDARY_SENTINEL, compactMetadata: { trigger: "auto", preTokens: 99 } },
    ]);
    const parse = eventsFor(bytes);

    expect(parse.session).toEqual({ sessionId: "boundary-only", cwd: "/fixture/repo", version: "2.1.270" });
    expect(parse.recordCount).toBe(1);
    expect(parse.events).toEqual([]);
    expect(() => claudeExtractConfig(parse, definition)).not.toThrow();
    expect(JSON.stringify(parse.events)).not.toContain(POST_COMPACT_BOUNDARY_SENTINEL);

    const directory = mkdtempSync(join(tmpdir(), "dcompact-compact-boundary-"));
    try {
      const transcript = join(directory, "boundary-only.jsonl");
      writeFileSync(transcript, bytes);
      const result = preview({ transcript, pack: {} });
      expect(result.degraded).toEqual(["extraction-empty"]);
      expect(result.report).toContain("session: boundary-only | cwd: /fixture/repo | cli: 2.1.270");
      expect(result.pack).not.toContain(POST_COMPACT_BOUNDARY_SENTINEL);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses compact-summary identity when it is the sole transcript context", () => {
    const bytes = source([
      { type: "user", isCompactSummary: true, sessionId: "summary-only", cwd: "/fixture/repo", version: "2.1.270", message: { role: "user", content: POST_COMPACT_SUMMARY_SENTINEL } },
    ]);
    const parse = eventsFor(bytes);

    expect(parse.session).toEqual({ sessionId: "summary-only", cwd: "/fixture/repo", version: "2.1.270" });
    expect(parse.recordCount).toBe(1);
    expect(parse.events).toEqual([]);
    expect(() => claudeExtractConfig(parse, definition)).not.toThrow();
    expect(JSON.stringify(parse.events)).not.toContain(POST_COMPACT_SUMMARY_SENTINEL);
  });

  it("degrades a malformed line without dropping the records around it", () => {
    const good = JSON.stringify({
      type: "assistant",
      uuid: "a",
      timestamp: null,
      cwd: "/fixture/repo",
      sessionId: "s",
      message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/fixture/repo/a.md" } }] },
    });
    const bytes = textEncoder.encode(`${good}\n{"type":"assistant",\n${good}`);

    const parse = eventsFor(bytes);
    expect(parse.diagnostics).toEqual([
      // The call has no result anywhere, reported once at its own line.
      { line: 1, code: "tool-call-without-result", detail: "Read" },
      { line: 2, code: "malformed-json", detail: "json" },
      // The repeated id is malformed, not a second call: reported, then refused in pass two.
      { line: 3, code: "tool-input-shape", detail: "duplicate-call-id" },
    ]);
    // One event for the one real call: the duplicate block must not be re-emitted from the
    // first call's data, which would invent a second call that never happened.
    expect(parse.events.filter((event) => event.type === "tool")).toHaveLength(1);
    expect(parse.toolCalls).toBe(1);
    const parsePayload = extractPayload(parse.events, claudeExtractConfig(parse, definition));
    // No result was observed, so no file fact is claimed even though the call is counted.
    expect(parsePayload.facts).toEqual([]);
    expect(parsePayload.counters.source_tool_calls).toBe(1);
  });

  it("never echoes unbounded transcript text into a diagnostic", () => {
    const bytes = source([{ type: "a".repeat(5000), uuid: "b" }]);
    const parse = eventsFor(bytes);

    expect(parse.diagnostics).toEqual([{ line: 1, code: "unknown-record-type", detail: "<other>" }]);
  });

  it("reports a tool result with no matching call and a call with no result", () => {
    const orphanResult = {
      type: "user",
      uuid: "r",
      timestamp: null,
      cwd: "/fixture/repo",
      sessionId: "s",
      message: { role: "user", content: [{ tool_use_id: "missing", type: "tool_result", content: "x" }] },
    };
    const orphanCall = {
      type: "assistant",
      uuid: "a",
      timestamp: null,
      cwd: "/fixture/repo",
      sessionId: "s",
      message: { role: "assistant", content: [{ type: "tool_use", id: "lonely", name: "Read", input: { file_path: "/fixture/repo/a.md" } }] },
    };
    const parse = eventsFor(source([orphanResult, orphanCall]));

    expect(parse.diagnostics).toEqual([
      { line: 1, code: "tool-result-without-call", detail: "result" },
      { line: 2, code: "tool-call-without-result", detail: "Read" },
    ]);
    const tool = parse.events.find((event) => event.type === "tool");
    // `isError: false` here means "not observed as failed", not "succeeded": the outcome of the
    // call is simply unknown, which `resultObserved: false` states explicitly.
    expect(tool?.type === "tool" ? tool.isError : null).toBe(false);
    expect(tool?.type === "tool" ? tool.resultObserved : null).toBe(false);
  });

  it("claims no file, command, or todo effect for a call whose result was never observed", () => {
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } },
      { type: "assistant", uuid: "b", parentUuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "rm -rf build" }, caller: { type: "direct" } }] } },
      { type: "assistant", uuid: "c", parentUuid: "b", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [{ type: "tool_use", id: "c2", name: "Write", input: { file_path: "/fixture/repo/out.txt", content: "x" }, caller: { type: "direct" } }] } },
      { type: "assistant", uuid: "d", parentUuid: "c", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [{ type: "tool_use", id: "c3", name: "TaskCreate", input: { subject: "Half a call" }, caller: { type: "direct" } }] } },
    ]);
    const parse = eventsFor(bytes);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));

    // The calls are seen and counted, but nothing is asserted about their effects.
    expect(payload.facts).toEqual([]);
    expect(payload.plan).toBeNull();
    expect(payload.counters.source_tool_calls).toBe(3);
    expect(payload.counters.unmapped_tool_calls).toBe(0);
    expect(payload.counters.coverage_ppm).toBe(1_000_000);
    expect(parse.events.filter((event) => event.type === "todo")).toEqual([]);
    expect(parse.diagnostics.map((item) => item.code)).toEqual([
      "tool-call-without-result",
      "tool-call-without-result",
      "tool-call-without-result",
    ]);
  });

  it("still reports the effect for a call whose result was observed", () => {
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } },
      ...pair("c1", "Bash", { command: "npm run check" }, { stdout: "ok" }),
    ]);
    const payload = extractPayload(eventsFor(bytes).events, claudeExtractConfig(eventsFor(bytes), definition));

    expect(payload.facts.map((fact) => `${fact.kind} ${fact.key}`)).toEqual(["cmd.run npm run check"]);
    expect(payload.counters.source_tool_calls).toBe(1);
  });

  it("emits no todo event for a TaskUpdate whose result was never observed", () => {
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } },
      { type: "assistant", uuid: "b", parentUuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "TaskUpdate", input: { taskId: "1", status: "completed" }, caller: { type: "direct" } }] } },
    ]);
    const parse = eventsFor(bytes);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));

    expect(parse.events.filter((event) => event.type === "todo")).toEqual([]);
    expect(payload.facts).toEqual([]);
    expect(parse.diagnostics).toEqual([{ line: 2, code: "tool-call-without-result", detail: "TaskUpdate" }]);
  });

  it("refuses a duplicate call id without letting its input become a fact", () => {
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } },
      { type: "assistant", uuid: "b", parentUuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "npm run check" }, caller: { type: "direct" } }] } },
      { type: "user", uuid: "c", parentUuid: "b", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "user", content: [{ tool_use_id: "c1", type: "tool_result", content: "ok" }] }, toolUseResult: { stdout: "ok" } },
      // Same id, different command: the second block must not produce an event or a fact.
      { type: "assistant", uuid: "d", parentUuid: "c", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "rm -rf /" }, caller: { type: "direct" } }] } },
    ]);
    const parse = eventsFor(bytes);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));

    expect(parse.diagnostics).toEqual([{ line: 4, code: "tool-input-shape", detail: "duplicate-call-id" }]);
    expect(parse.events.filter((event) => event.type === "tool")).toHaveLength(1);
    expect(payload.facts.map((fact) => fact.key)).toEqual(["npm run check"]);
    expect(payload.counters.source_tool_calls).toBe(1);
  });

  it("counts a truly unobserved future tool and lowers coverage without degrading", () => {
    // Deliberately absent from the observed vocabulary in ADAPTER-SPEC §2: this is the shape of
    // vocabulary drift, and it must stay unmapped rather than be guessed into a kind.
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } },
      ...pair("c1", "QuantumRefactor", { target: "everything" }, { content: "done" }),
    ]);
    const parse = eventsFor(bytes);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));

    expect(parse.diagnostics).toEqual([]);
    expect(claudeToolKinds(parse.toolNames, definition)).toEqual({});
    expect(payload.counters.source_tool_calls).toBe(1);
    expect(payload.counters.unmapped_tool_calls).toBe(1);
    expect(payload.counters.coverage_ppm).toBe(0);
    expect(payload.facts).toEqual([]);
  });

  it("decides every exact non-MCP tool name in the observed vocabulary", () => {
    // The vocabulary measured in P4 (ADAPTER-SPEC §2), non-MCP names only, with the decision
    // each one must carry. A name that stops being decided fails here instead of silently
    // becoming an unmapped call.
    const observed: ReadonlyArray<readonly [string, string]> = [
      ["Bash", "command"],
      ["Read", "file.read"],
      ["Edit", "file.modified"],
      ["Write", "file.modified"],
      ["TaskUpdate", "todo"],
      ["TaskCreate", "todo"],
      ["AskUserQuestion", "ignored"],
      ["ToolSearch", "ignored"],
      ["Agent", "ignored"],
      ["WebFetch", "ignored"],
      ["ListAgents", "ignored"],
      ["Artifact", "ignored"],
      ["TaskList", "ignored"],
      ["Skill", "ignored"],
      ["ScheduleWakeup", "ignored"],
      ["ExitPlanMode", "ignored"],
    ];

    for (const [name, kind] of observed) {
      expect(CLAUDE_TOOL_KINDS[name], `${name} must be decided as ${kind}`).toBe(kind);
    }
    // A decided name is never counted as unmapped by core, and the derived map matches.
    const names = observed.map(([name]) => name);
    expect(Object.keys(claudeToolKinds(names, definition)).sort()).toEqual([...names].sort());
    // MCP names are the documented prefix rule, not table entries.
    expect(observed.some(([name]) => name.startsWith("mcp__"))).toBe(false);
    expect(CLAUDE_TOOL_KINDS["mcp__linear__linear_list_projects"]).toBeUndefined();
    // MultiEdit and NotebookEdit are absent from the observed vocabulary, so they stay
    // undecided: a real call must show up as counted drift, not be absorbed by a guess.
    expect(CLAUDE_TOOL_KINDS.MultiEdit).toBeUndefined();
    expect(CLAUDE_TOOL_KINDS.NotebookEdit).toBeUndefined();
  });

  it("ignores MCP tools by the documented prefix rule", () => {
    const kinds = claudeToolKinds(["mcp__linear__list_projects", "mcp__whatever__tool", "Bash"], definition);

    expect(kinds).toEqual({
      "mcp__linear__list_projects": "ignored",
      "mcp__whatever__tool": "ignored",
      Bash: "command",
    });
  });

  it("keeps a path outside the session cwd opaque, with no host path text", () => {
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } },
      ...pair("c1", "Write", { file_path: "/outside/private/report.md", content: "x" }, { type: "create" }),
    ]);
    const payload = extractPayload(eventsFor(bytes).events, claudeExtractConfig(eventsFor(bytes), definition));
    const serialized = canonicalize(payload);

    expect(payload.facts[0].key).toMatch(/^[0-9a-f]{12}:report\.md$/);
    expect(payload.facts[0].scope).toBe("external");
    // The fact survives and is counted, but no host path text does.
    expect(payload.counters.external_path_count).toBe(1);
    expect(serialized).not.toContain("/outside/private");
    expect(serialized).toContain("report.md");
  });

  it("degrades a path equal to the scope root instead of failing the extraction", () => {
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } },
      ...pair("c1", "Write", { file_path: "/fixture/repo", content: "x" }, { type: "create" }),
    ]);
    const parse = eventsFor(bytes);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));

    expect(parse.diagnostics).toEqual([{ line: 2, code: "path-unrepresentable", detail: "scope-root" }]);
    expect(payload.facts).toEqual([]);
    expect(payload.counters.source_tool_calls).toBe(1);
  });

  it("emits todo events for task tools from the paired result", () => {
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } },
      ...pair("c1", "TaskCreate", { subject: "Audit mapper", description: "d" }, { task: { id: "1", subject: "Audit mapper" } }),
      ...pair("c2", "TaskUpdate", { taskId: "1", status: "completed" }, { success: true, taskId: "1" }),
    ]);
    const parse = eventsFor(bytes);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));

    expect(parse.diagnostics).toEqual([]);
    // Last-write-wins on `text`: the update's status replaces the create's subject.
    expect(payload.facts.filter((fact) => fact.kind === "todo.state").map((fact) => [fact.key, fact.attrs.text])).toEqual([
      ["item:1", "completed"],
    ]);
    // Todo events do not synthesize a plan: `payload.plan` stays null because no `plan`
    // record type exists in a Claude transcript.
    expect(payload.plan).toBeNull();
    expect(payload.counters.unmapped_tool_calls).toBe(0);
  });

  it("backs a TaskCreate todo with the result line that assigns its id", () => {
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } },
      ...pair("c1", "TaskCreate", { subject: "Audit mapper", description: "d" }, { task: { id: "7", subject: "Audit mapper" } }),
    ]);
    const parse = eventsFor(bytes);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));
    const lines = physicalLines(bytes);
    const fact = payload.facts.find((item) => item.kind === "todo.state");

    expect(fact?.key).toBe("item:7");
    // The call is physical line 2 and its result is line 3; the id `7` exists only on line 3.
    expect(fact?.evidence.map((entry) => entry.line)).toEqual([2, 3]);
    expect(fact?.evidence[0].sha256).toBe(lineHash(lines[1]));
    expect(fact?.evidence[1].sha256).toBe(lineHash(lines[2]));
    expect(textDecoder.decode(lines[2])).toContain('"id":"7"');
    // The assigned task id exists only on the result line; the call line carries the tool-call
    // id instead, which is exactly why the call line alone cannot back this fact.
    expect(textDecoder.decode(lines[1])).toContain('"id":"c1"');
    expect(textDecoder.decode(lines[1])).not.toContain('"id":"7"');
    expect(textDecoder.decode(lines[1])).not.toContain('"task"');
  });

  it("backs a TaskUpdate todo with its paired result line too", () => {
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } },
      ...pair("c1", "TaskUpdate", { taskId: "3", status: "completed" }, { success: true, taskId: "3" }),
    ]);
    const parse = eventsFor(bytes);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));
    const lines = physicalLines(bytes);
    const fact = payload.facts.find((item) => item.kind === "todo.state");

    expect(fact?.evidence.map((entry) => entry.line)).toEqual([2, 3]);
    expect(fact?.evidence[1].sha256).toBe(lineHash(lines[2]));
  });

  it("labels an unknown task status rather than inventing a state", () => {
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } },
      ...pair("c1", "TaskUpdate", { taskId: "1", status: "blocked" }, { success: true }),
    ]);
    const parse = eventsFor(bytes);

    expect(parse.diagnostics).toEqual([{ line: 2, code: "task-status-unknown", detail: "blocked" }]);
  });

  it("records a todo without a task id as a shape diagnostic, not a guessed identity", () => {
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } },
      ...pair("c1", "TaskCreate", { subject: "No id" }, { ok: true }),
    ]);
    const parse = eventsFor(bytes);

    expect(parse.diagnostics).toEqual([{ line: 2, code: "task-result-shape", detail: "task-create" }]);
  });

  it("ignores thinking and text blocks without treating them as drift", () => {
    const bytes = source([
      {
        type: "assistant",
        uuid: "a",
        timestamp: null,
        cwd: "/fixture/repo",
        sessionId: "s",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: "hello" }] },
      },
    ]);

    expect(eventsFor(bytes).diagnostics).toEqual([]);
  });
});

describe("determinism", () => {
  it("produces byte-identical payload and hash across repeated runs", () => {
    const first = eventsFor(fixtureBytes);
    const second = eventsFor(fixtureBytes.slice());
    const firstPayload = extractPayload(first.events, claudeExtractConfig(first, definition));
    const secondPayload = extractPayload(second.events, claudeExtractConfig(second, definition));

    expect(canonicalize(firstPayload)).toBe(canonicalize(secondPayload));
    expect(payloadHash(firstPayload)).toBe(payloadHash(secondPayload));
  });
});

describe("preview CLI", () => {
  function capture(argv: readonly string[]): { status: number; stdout: string; stderr: string } {
    let stdout = "";
    let stderr = "";
    const io: CliIo = { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) };
    const status = run(argv, io);
    return { status, stdout, stderr };
  }

  it("prints the pack on stdout and the report on stderr, with no overlap", () => {
    const result = capture(["preview", "--transcript", fixturePath]);

    expect(result.status).toBe(0);
    expect(result.stdout.startsWith("## dcompact context [dcompact:")).toBe(true);
    expect(result.stdout).toContain("- **file.modified** `src/util.ts`");
    expect(result.stdout).toContain("- **error.fixed**");
    expect(result.stderr).toContain("health: ok");
    expect(result.stderr).toContain("coverage: 1000000 ppm");
    expect(result.stderr).not.toContain("## dcompact context");
    expect(result.stdout).not.toContain("payload hash:");
  });

  it("never chooses a transcript when one is not given", () => {
    const result = capture(["preview"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no session is ever chosen for you");
    expect(result.stderr).toContain("Usage:");
  });

  it("distinguishes a usage error from an unreadable transcript from an unknown command", () => {
    const usage = capture(["preview", "--max-bytes", "abc"]);
    const unreadable = capture(["preview", "--transcript", join(fixtureDirectory, "missing.jsonl")]);
    const unknown = capture(["snapshot"]);

    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("--max-bytes requires a non-negative integer");
    expect(unreadable.status).toBe(3);
    expect(unreadable.stderr).toContain("Cannot read transcript");
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('Unknown command: "snapshot"');
  });

  it("honours the pack budget and evidence flag", () => {
    const small = capture(["preview", "--transcript", fixturePath, "--max-bytes", "700"]);
    const evidence = capture(["preview", "--transcript", fixturePath, "--include-evidence"]);

    expect(small.status).toBe(0);
    expect(Buffer.byteLength(small.stdout, "utf8")).toBeLessThanOrEqual(700);
    expect(small.stdout).toContain("elided");
    // Each evidence group now names both physical lines of the non-adjacent call/result pair.
    expect(evidence.stdout).toContain("line 18, line 19");
    expect(evidence.stdout).toContain("line 12, line 13");
  });

  it("states ok health in the pack header for a clean transcript", () => {
    const result = capture(["preview", "--transcript", fixturePath]);

    expect(result.status).toBe(0);
    // The status is in the stdout pack, not only in the stderr report.
    expect(result.stdout).toContain("\nStatus: ok\n");
    expect(result.stdout.split("\n")[0]).toMatch(/^## dcompact context \[dcompact:[0-9a-f]{12}\]$/);
    expect(result.stdout.split("\n")[1]).toBe("Status: ok");
    expect(result.stderr).toContain("health: ok");
  });

  it("stays byte-identical when health is not supplied", () => {
    const parse = parseClaudeTranscript(fixtureBytes, definition);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));
    const withoutHealth = renderPack(payload);
    const okHealth = renderPack(payload, { degraded: [] });

    expect(withoutHealth).not.toContain("Status:");
    expect(okHealth).toContain("Status: ok");
    // Health is display-only: the status-free pack is the same document minus that one line.
    const stripped = okHealth.split("\n").filter((line) => line !== "Status: ok").join("\n");
    expect(stripped).toBe(withoutHealth);
    expect(payloadHash(payload)).toBe(payloadHash(extractPayload(parse.events, claudeExtractConfig(parse, definition))));
    // Neither the payload nor any of its members carries health.
    expect(Object.keys(payload)).not.toContain("status");
    expect(Object.keys(payload)).not.toContain("degraded");
    expect(canonicalize(payload)).not.toContain("schema-drift");
    expect(canonicalize(payload)).not.toContain("extraction-empty");
  });

  it("renders health from finite tokens only, never from caller text", () => {
    const parse = parseClaudeTranscript(fixtureBytes, definition);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));

    // `ok` is the absence-of-degradation token, not a state to combine.
    expect(renderPack(payload, { degraded: ["ok"] })).toContain("Status: ok");
    expect(renderPack(payload, { degraded: ["ok", "schema-drift"] })).toContain("Status: degraded: schema-drift");
    // Order and duplicates are normalized, so equal health renders identically.
    const a = renderPack(payload, { degraded: ["schema-drift", "extraction-empty"] });
    const b = renderPack(payload, { degraded: ["extraction-empty", "schema-drift", "extraction-empty"] });
    expect(a).toBe(b);
    expect(a).toContain("Status: degraded: extraction-empty, degraded: schema-drift");
    // Arbitrary text is impossible at the type boundary, not merely discouraged. These are
    // compile-time assertions with no runtime effect: each `@ts-expect-error` fails
    // `npm run typecheck` if the types ever widen to accept free-form health text or a
    // free-form `status` option.
    // @ts-expect-error health must be a finite DegradedState token
    void ((): PackOptions => ({ degraded: ["totally-fine-really"] }));
    // @ts-expect-error the free-form status option was removed in favour of `degraded`
    void ((): PackOptions => ({ status: "ok" }));
  });

  it("keeps each degraded state in its documented family", () => {
    const parse = parseClaudeTranscript(fixtureBytes, definition);
    const payload = extractPayload(parse.events, claudeExtractConfig(parse, definition));
    const statusOf = (degraded: DegradedState[]): string =>
      renderPack(payload, { degraded }).split("\n").find((line) => line.startsWith("Status: ")) ?? "<missing>";

    // Plain internal tokens are reported as degraded; prefixed families keep their own prefix.
    expect(statusOf(["schema-drift"])).toBe("Status: degraded: schema-drift");
    expect(statusOf(["internal-error"])).toBe("Status: degraded: internal-error");
    expect(statusOf(["unavailable:store"])).toBe("Status: unavailable:store");
    expect(statusOf(["untrusted:hook-pending-review"])).toBe("Status: untrusted:hook-pending-review");
    expect(statusOf(["unavailable:agent-not-installed", "no-pre-compaction-hook"])).toBe(
      "Status: degraded: no-pre-compaction-hook, unavailable:agent-not-installed",
    );
    // Mixed families: a prefix is never applied twice, and the order is by rendered token.
    expect(statusOf(["schema-drift", "unavailable:store", "extraction-empty", "untrusted:hook-pending-review"])).toBe(
      "Status: degraded: extraction-empty, degraded: schema-drift, unavailable:store, untrusted:hook-pending-review",
    );
    // `ok` only appears when it is the sole non-filtered state.
    expect(statusOf(["ok", "unavailable:store"])).toBe("Status: unavailable:store");
    expect(statusOf(["ok", "ok"])).toBe("Status: ok");
    expect(statusOf([])).toBe("Status: ok");
  });

  it("states schema-drift on stdout and claims no effect when a call has no result", () => {
    const directory = mkdtempSync(join(tmpdir(), "dcompact-cli-"));
    try {
      const file = join(directory, "unpaired.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify({ type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } }),
          JSON.stringify({ type: "assistant", uuid: "b", parentUuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "npm publish" }, caller: { type: "direct" } }] } }),
        ].join("\n"),
      );

      const result = capture(["preview", "--transcript", file]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Status: degraded: schema-drift");
      expect(result.stderr).toContain("health: degraded: schema-drift");
      expect(result.stderr).toContain("line 2: tool-call-without-result (Bash)");
      // The call is counted, but nothing is claimed about what it did.
      expect(result.stderr).toContain("tool calls: 1");
      expect(result.stderr).toContain("coverage: 1000000 ppm");
      expect(result.stdout).toContain("Facts: 0");
      expect(result.stdout).not.toContain("cmd.run");
      expect(result.stdout).not.toContain("npm publish");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("states schema-drift health in the stdout pack for unknown records", () => {
    const directory = mkdtempSync(join(tmpdir(), "dcompact-cli-"));
    try {
      const mixed = join(directory, "mixed.jsonl");
      const lines = [
        { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/fixture/repo/a.md" } }] } },
        { type: "brand-new-shape", uuid: "b", timestamp: null },
        { type: "user", uuid: "c", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "user", content: [{ tool_use_id: "c1", type: "tool_result", content: "ok" }] } },
      ];
      writeFileSync(mixed, lines.map((line) => JSON.stringify(line)).join("\n"));

      const result = capture(["preview", "--transcript", mixed]);
      expect(result.status).toBe(0);
      // visible on stdout, where a reader of the pack actually sees it
      expect(result.stdout).toContain("Status: degraded: schema-drift");
      expect(result.stdout).not.toContain("Status: ok");
      expect(result.stderr).toContain("health: degraded: schema-drift");
      expect(result.stderr).toContain("line 2: unknown-record-type (brand-new-shape)");
      expect(result.stdout).toContain("**file.read** `a.md`");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("states schema-drift health in the stdout pack for a malformed line", () => {
    const directory = mkdtempSync(join(tmpdir(), "dcompact-cli-"));
    try {
      const broken = join(directory, "broken.jsonl");
      const good = JSON.stringify({
        type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s",
        message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/fixture/repo/a.md" } }] },
      });
      const result = JSON.stringify({
        type: "user", uuid: "b", timestamp: null, cwd: "/fixture/repo", sessionId: "s",
        message: { role: "user", content: [{ tool_use_id: "c1", type: "tool_result", content: "ok" }] },
      });
      writeFileSync(broken, `${good}\n{"type":"assistant",\n${result}`);

      const output = capture(["preview", "--transcript", broken]);
      expect(output.status).toBe(0);
      expect(output.stdout).toContain("Status: degraded: schema-drift");
      expect(output.stderr).toContain("line 2: malformed-json");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports extraction-empty in the pack header for an empty transcript", () => {
    const directory = mkdtempSync(join(tmpdir(), "dcompact-cli-"));
    try {
      const empty = join(directory, "empty.jsonl");
      // A recognized conversation record with no extractable content: no drift, no facts.
      writeFileSync(empty, JSON.stringify({
        type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s",
        message: { role: "assistant", content: [] },
      }));

      const result = capture(["preview", "--transcript", empty]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Status: degraded: extraction-empty");
      expect(result.stderr).toContain("health: degraded: extraction-empty");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("combines parser drift and extraction-empty into one deterministic status", () => {
    const directory = mkdtempSync(join(tmpdir(), "dcompact-cli-"));
    try {
      const file = join(directory, "drift-only.jsonl");
      // A recognized conversation record with a cwd but no extractable content, plus one
      // unknown record: drift and no facts at the same time, which must render as one status.
      writeFileSync(
        file,
        [
          JSON.stringify({ type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } }),
          JSON.stringify({ type: "brand-new-shape", uuid: "b", timestamp: null }),
        ].join("\n"),
      );

      const result = capture(["preview", "--transcript", file]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Status: degraded: extraction-empty, degraded: schema-drift");
      expect(result.stderr).toContain("health: degraded: extraction-empty, degraded: schema-drift");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("degrades schema drift and reports the exact diagnostics", () => {
    const directory = mkdtempSync(join(tmpdir(), "dcompact-cli-"));
    try {
      const mixed = join(directory, "mixed.jsonl");
      const lines = [
        { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/fixture/repo/a.md" } }] } },
        { type: "brand-new-shape", uuid: "b", timestamp: null },
        { type: "user", uuid: "c", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "user", content: [{ tool_use_id: "c1", type: "tool_result", content: "ok" }] } },
      ];
      writeFileSync(mixed, lines.map((line) => JSON.stringify(line)).join("\n"));

      const result = capture(["preview", "--transcript", mixed]);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("health: degraded: schema-drift");
      expect(result.stderr).toContain("diagnostics: 1");
      expect(result.stderr).toContain("line 2: unknown-record-type (brand-new-shape)");
      expect(result.stdout).toContain("**file.read** `a.md`");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a transcript whose cwd is absent rather than guessing one", () => {
    const directory = mkdtempSync(join(tmpdir(), "dcompact-cli-"));
    try {
      const noCwd = join(directory, "no-cwd.jsonl");
      writeFileSync(
        noCwd,
        JSON.stringify({ type: "assistant", uuid: "a", timestamp: null, sessionId: "s", message: { role: "assistant", content: [] } }),
      );

      const result = capture(["preview", "--transcript", noCwd]);
      expect(result.status).toBe(4);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Refusing to preview");
      expect(result.stderr).toContain("cwd");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses flags directly for callers that bypass the process", () => {
    expect(parsePreviewArgs(["--transcript", "a.jsonl", "--max-facts", "3", "--include-evidence"])).toEqual({
      transcript: "a.jsonl",
      pack: { maxFacts: 3, includeEvidence: true },
    });
    expect(() => parsePreviewArgs(["--nope"])).toThrow(UsageError);
  });

  it("refuses an unusably small --max-bytes as usage, without an internal-error stack", () => {
    for (const budget of ["0", "64", "200"]) {
      const result = capture(["preview", "--transcript", fixturePath, "--max-bytes", budget]);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--max-bytes must be at least");
      // The old path surfaced `RangeError: maxBytes cannot contain …` plus a Node stack.
      expect(result.stderr).not.toContain("RangeError");
      expect(result.stderr).not.toContain("Internal error");
      expect(result.stderr).not.toMatch(/\n\s+at /);
      // A refusal prints the exact next step, per the repository's refusal convention.
      expect(result.stderr).toContain("--max-bytes");
      expect(result.stderr).toContain("--help");
    }
  });

  it("names a minimum --max-bytes that is exactly the boundary, and one byte less refuses", () => {
    const refusal = capture(["preview", "--transcript", fixturePath, "--max-bytes", "0"]);
    const minimum = Number(/--max-bytes must be at least (\d+)/.exec(refusal.stderr)?.[1]);
    expect(Number.isSafeInteger(minimum)).toBe(true);
    expect(minimum).toBeGreaterThan(0);

    // At the reported minimum the pack renders, and it holds the header and the elision notice.
    const atMinimum = capture(["preview", "--transcript", fixturePath, "--max-bytes", String(minimum)]);
    expect(atMinimum.status).toBe(0);
    expect(new TextEncoder().encode(atMinimum.stdout).byteLength).toBeLessThanOrEqual(minimum);
    expect(atMinimum.stdout).toContain("## dcompact context [dcompact:");
    expect(atMinimum.stdout).toContain("elided 9 facts");

    // One byte below it is refused, which is what makes the reported number the boundary.
    const below = capture(["preview", "--transcript", fixturePath, "--max-bytes", String(minimum - 1)]);
    expect(below.status).toBe(2);
    expect(below.stdout).toBe("");
    expect(below.stderr).toContain(`at least ${minimum}`);
  });

  it("still renders a budget just large enough for the whole pack", () => {
    const full = capture(["preview", "--transcript", fixturePath]);
    const exact = new TextEncoder().encode(full.stdout).byteLength;
    const result = capture(["preview", "--transcript", fixturePath, "--max-bytes", String(exact)]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(full.stdout);
  });

  it("returns a structured preview result for direct callers", () => {
    const result = preview({ transcript: fixturePath, pack: {} });

    expect(result.degraded).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.payload.counters.facts).toBe(9);
    expect(payloadHash(result.payload)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("packaging", () => {
  it("declares a bin entry that points at the compiled CLI, not a TypeScript source file", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      readonly bin?: Record<string, string>;
      readonly dependencies?: Record<string, string>;
      readonly private?: boolean;
      readonly license?: string;
      readonly description?: string;
      readonly repository?: { readonly url?: string };
    };

    expect(manifest.bin?.dcompact).toBe("dist/cli.js");
    expect(Object.keys(manifest.bin ?? {})).toEqual(["dcompact"]);
    // P6a adds no runtime dependency: the CLI only uses `node:fs` and `node:url`.
    expect(manifest.dependencies ?? {}).toEqual({});
    // `private` is the guard against an accidental publish while the roadmap is unfinished; the
    // metadata below it exists so a packed tarball and the public repository describe themselves.
    expect(manifest.private).toBe(true);
    expect(manifest.license).toBe("MIT");
    // Matches the README subtitle, so the packed tarball and the repository say the same thing.
    expect(manifest.description).toBe("Deterministic, rule-based memory for coding agents — no model in the extraction path.");
    expect(manifest.repository?.url).toContain("github.com/TomaszGonczar/dcompact");
  });

  it("ships the MIT license text the README points at", () => {
    const license = readFileSync(join(process.cwd(), "LICENSE"), "utf8");

    expect(license.startsWith("MIT License\n")).toBe(true);
    expect(license).toContain("Copyright (c) 2026 Tomasz Gonczar");
    expect(license).toContain("THE SOFTWARE IS PROVIDED \"AS IS\"");
  });

  // A package-manager bin is a symlink, and on macOS the temp directory itself is a symlink,
  // so a naive `import.meta.url === pathToFileURL(process.argv[1])` guard makes the installed
  // command exit 0 having printed nothing. This compiles the real entry with the real build
  // config into a temp directory, links it the way npm does, and requires real pack output.
  //
  // The compiled CLI resolves its adapter definitions from `adapters/` beside the package root,
  // never from the cwd (P5: where a process started must not decide which vocabulary extraction
  // uses). A build emitted outside the package tree therefore needs that directory beside it,
  // which is what this symlink reproduces — the same layout the published package ships.
  it("runs the compiled entry through a bin symlink without going silent", () => {
    const directory = mkdtempSync(join(tmpdir(), "dcompact-bin-"));
    try {
      const outDir = join(directory, "dist");
      execFileSync(process.execPath, [join(process.cwd(), "node_modules", "typescript", "bin", "tsc"), "--project", "tsconfig.build.json", "--outDir", outDir], {
        cwd: process.cwd(),
        stdio: "ignore",
      });
      symlinkSync(join(process.cwd(), "adapters"), join(directory, "adapters"));
      const entry = join(outDir, "cli.js");
      const link = join(directory, "dcompact");
      symlinkSync(entry, link);

      const stdout = execFileSync(process.execPath, [link, "preview", "--transcript", fixturePath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });

      expect(stdout.startsWith("## dcompact context [dcompact:")).toBe(true);
      expect(stdout).toContain("- **file.modified** `src/util.ts`");

      // The exit-code contract must survive packaging too, since the guard runs before `run`.
      // `execFileSync` reports a nonzero exit by throwing; the status is read with a guard
      // rather than asserted, so a missing property cannot be silently trusted.
      const exitStatusOf = (error: unknown): number =>
        typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
          ? error.status
          : 0;
      let missingStatus = 0;
      try {
        execFileSync(process.execPath, [link, "preview"], { stdio: "ignore" });
      } catch (error) {
        missingStatus = exitStatusOf(error);
      }
      expect(missingStatus).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
