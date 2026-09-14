import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkpoint, ContinuityRefusal, CorruptCheckpointError, injectPack, listCheckpoints, restore, runHook } from "../src/continuity.js";
import { mergeCheckpointPayloads } from "../src/core/continuity.js";
import { payloadHash } from "../src/core/hash.js";
import { renderPack } from "../src/core/pack.js";
import type { Fact, Payload } from "../src/core/types.js";

const fixture = join(process.cwd(), "test", "fixtures", "claude", "slice-0001", "transcript.jsonl");

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dcompact-og85-"));
}

function fact(entry: number, text: string): Fact {
  return {
    kind: "decision.stated",
    key: text,
    at: { entry, ts: null },
    attrs: { cue: "must" },
    evidence: [{ line: entry + 1, sha256: `sha256:${String(entry).padStart(64, "0")}` }],
    snippet: text,
    unbacked: false,
  };
}

function payload(facts: Fact[]): Payload {
  return {
    facts,
    counters: {
      facts: facts.length,
      by_kind: { "decision.stated": facts.length },
      source_entries: facts.length,
      source_tool_calls: 0,
      unmapped_tool_calls: 0,
      coverage_ppm: 0,
      external_path_count: 0,
    },
    git: null,
    plan: null,
    path_base: "cwd",
    version: 1,
  };
}

function cumulativeRunFact(evidenceLines: number[]): Fact {
  return {
    kind: "cmd.run",
    key: "npm test",
    at: { entry: 0, ts: null },
    attrs: { runs: 1, failed: false },
    evidence: evidenceLines.map((line) => ({ line, sha256: `sha256:${String(line).padStart(64, "0")}` })),
    snippet: "Run tests",
    unbacked: false,
  };
}

function updatingRunFact(runs: number, evidenceLines: number[], snippet: string): Fact {
  return {
    kind: "cmd.run",
    key: "npm test",
    at: { entry: runs, ts: null },
    attrs: { runs, failed: runs % 2 === 0 },
    evidence: evidenceLines.map((line) => ({ line, sha256: `sha256:${String(line).padStart(64, "0")}` })),
    snippet,
    unbacked: false,
  };
}

describe("Claude continuity slice", () => {
  it("merges four epochs while retaining earlier durable facts", () => {
    const merged = mergeCheckpointPayloads([
      payload([fact(0, "epoch one"), fact(1, "epoch two")]),
      payload([fact(0, "epoch one"), fact(1, "epoch two"), fact(2, "epoch three")]),
      payload([fact(0, "epoch one"), fact(1, "epoch two"), fact(2, "epoch three"), fact(3, "epoch four")]),
      payload([fact(0, "epoch one"), fact(1, "epoch two"), fact(2, "epoch three"), fact(3, "epoch four"), fact(4, "epoch five")]),
    ]);
    expect(merged.facts.map((item) => item.key).sort()).toEqual(["epoch five", "epoch four", "epoch one", "epoch three", "epoch two"]);
    const cumulative = mergeCheckpointPayloads([
      payload([cumulativeRunFact([1])]),
      payload([cumulativeRunFact([1, 2])]),
      payload([cumulativeRunFact([1, 2, 3])]),
      payload([cumulativeRunFact([1, 2, 3, 4])]),
    ]);
    expect(cumulative.facts).toHaveLength(1);
    expect(cumulative.facts[0]?.attrs.runs).toBe(1);
  });

  it("uses the latest chain fact as a whole when capped evidence overlaps", () => {
    const merged = mergeCheckpointPayloads([
      payload([updatingRunFact(5, [1, 2, 3, 4, 5], "old result")]),
      payload([updatingRunFact(6, [2, 3, 4, 5, 6], "updated result")]),
      payload([fact(20, "earlier-only identity")]),
      payload([updatingRunFact(7, [3, 4, 5, 6, 7], "latest result")]),
    ]);
    const run = merged.facts.find((item) => item.kind === "cmd.run");
    expect(run).toMatchObject({
      key: "npm test",
      attrs: { runs: 7, failed: false },
      snippet: "latest result",
      at: { entry: 7 },
    });
    expect(run?.evidence).toHaveLength(5);
    expect(merged.facts.map((item) => item.key)).toContain("earlier-only identity");
  });

  it("resolves conflicting identities deterministically by chain order", () => {
    const older = updatingRunFact(1, [11], "older");
    const newer = updatingRunFact(2, [12], "newer");
    const first = mergeCheckpointPayloads([payload([older]), payload([newer])]);
    const second = mergeCheckpointPayloads([payload([older]), payload([newer])]);
    expect(first).toEqual(second);
    expect(first.facts[0]).toMatchObject({ attrs: { runs: 2 }, snippet: "newer" });
    expect(mergeCheckpointPayloads([payload([newer]), payload([older])]).facts[0]).toMatchObject({ attrs: { runs: 2 }, snippet: "older" });
  });

  it("keeps latest source counters, marks earlier-only facts unbacked, and unions health at restore", () => {
    const older = payload([fact(0, "historical")]);
    const newer = payload([fact(1, "current")]);
    const merged = mergeCheckpointPayloads([
      { ...older, counters: { ...older.counters, source_entries: 100, source_tool_calls: 10, unmapped_tool_calls: 1, coverage_ppm: 900000 } },
      { ...newer, counters: { ...newer.counters, source_entries: 2, source_tool_calls: 2, unmapped_tool_calls: 0, coverage_ppm: 1000000 } },
    ]);
    expect(merged.counters).toMatchObject({ source_entries: 2, source_tool_calls: 2, unmapped_tool_calls: 0, coverage_ppm: 1000000 });
    expect(merged.facts.find((item) => item.key === "historical")?.unbacked).toBe(true);
    expect(merged.facts.find((item) => item.key === "current")?.unbacked).toBe(false);
  });

  it("renders an explicit unbacked marker with or without evidence", () => {
    const merged = mergeCheckpointPayloads([payload([fact(0, "historical")]), payload([fact(1, "current")])]);
    const withoutEvidence = renderPack(merged);
    const withEvidence = renderPack(merged, { includeEvidence: true });
    expect(withoutEvidence).toContain("historical — unbacked");
    expect(withoutEvidence).not.toContain("line 1");
    expect(withEvidence).toContain("line 1 — unbacked");
  });

  it("marks merged historical provenance as degraded in the restored pack", () => {
    const root = tempRoot();
    const shortTranscript = join(root, "short.jsonl");
    try {
      writeFileSync(shortTranscript, JSON.stringify({
        type: "user",
        uuid: "short-user",
        timestamp: "2026-01-01T00:01:00.000Z",
        cwd: "/fixture/repo",
        sessionId: "fixture-session-0001",
        version: "2.1.238",
        message: { role: "user", content: "We must retain this current fact." },
      }));
      checkpoint({ root, sessionId: "fixture-session-0001", transcriptPath: fixture });
      checkpoint({ root, sessionId: "fixture-session-0001", transcriptPath: shortTranscript });
      const restored = restore({ root, sessionId: "fixture-session-0001" });
      expect(restored.pack).toContain("Status: degraded: provenance-broken");
      expect(restored.pack).toContain("unbacked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checkpoints an explicit session id idempotently and restores at 16 KiB", () => {
    const root = tempRoot();
    try {
      const first = checkpoint({ root, sessionId: "fixture-session-0001", transcriptPath: fixture, now: () => 1 });
      const second = checkpoint({ root, sessionId: "fixture-session-0001", transcriptPath: fixture, now: () => 2 });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(listCheckpoints({ root, sessionId: "fixture-session-0001" })).toHaveLength(1);
      const result = restore({ root, sessionId: "fixture-session-0001" });
      expect(new TextEncoder().encode(result.pack).byteLength).toBeLessThanOrEqual(16_384);
      expect(result.pack).toContain("[dcompact:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("orders checkpoints by ancestry and refuses a broken chain", () => {
    const root = tempRoot();
    const transcript = join(root, "transcript.jsonl");
    try {
      writeFileSync(transcript, readFileSync(fixture));
      const first = checkpoint({ root, sessionId: "fixture-session-0001", transcriptPath: transcript, now: () => 1 });
      const extra = {
        type: "user",
        uuid: "fixture-extra-user",
        timestamp: "2026-01-01T00:01:00.000Z",
        cwd: "/fixture/repo",
        sessionId: "fixture-session-0001",
        version: "2.1.238",
        message: { role: "user", content: "We must preserve the checkpoint chain." },
      };
      writeFileSync(transcript, `${readFileSync(transcript, "utf8")}\n${JSON.stringify(extra)}`);
      const second = checkpoint({ root, sessionId: "fixture-session-0001", transcriptPath: transcript, now: () => 2 });
      const ordered = listCheckpoints({ root, sessionId: "fixture-session-0001" });
      expect(ordered.map((snapshot) => snapshot.envelope.hash)).toEqual([first.snapshot.envelope.hash, second.snapshot.envelope.hash]);
      const tampered = JSON.parse(readFileSync(second.path, "utf8")) as { envelope: { previous_hash: string | null } };
      tampered.envelope.previous_hash = null;
      writeFileSync(second.path, `${JSON.stringify(tampered)}\n`);
      expect(() => listCheckpoints({ root, sessionId: "fixture-session-0001" })).toThrow(CorruptCheckpointError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a corrupt checkpoint and never injects it", () => {
    const root = tempRoot();
    try {
      const result = checkpoint({ root, sessionId: "fixture-session-0001", transcriptPath: fixture });
      const validPack = restore({ root, sessionId: "fixture-session-0001" }).pack;
      writeFileSync(result.path, readFileSync(result.path, "utf8").replace('"version":1', '"version":2'));
      expect(() => listCheckpoints({ root, sessionId: "fixture-session-0001" })).toThrow(CorruptCheckpointError);
      expect(injectPack("", validPack).injected).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed envelope fields before restore", () => {
    const root = tempRoot();
    try {
      const result = checkpoint({ root, sessionId: "fixture-session-0001", transcriptPath: fixture });
      const original = readFileSync(result.path, "utf8");
      const malformed: Array<[string, unknown]> = [
        ["schema_version", "0.0.0"],
        ["canonicalization", 2],
        ["extractor_version", "0.0.1"],
        ["adapter", "codex"],
        ["session_id", "contains spaces"],
        ["hash", "sha256:broken"],
        ["previous_hash", "sha256:broken"],
      ];
      for (const [field, value] of malformed) {
        const snapshot = JSON.parse(original) as { envelope: Record<string, unknown> };
        snapshot.envelope[field] = value;
        writeFileSync(result.path, `${JSON.stringify(snapshot)}\n`);
        expect(() => listCheckpoints({ root, sessionId: "fixture-session-0001" }), field).toThrow(CorruptCheckpointError);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a checkpoint copied into a different session directory", () => {
    const root = tempRoot();
    try {
      const result = checkpoint({ root, sessionId: "fixture-session-0001", transcriptPath: fixture });
      const otherDir = join(root, "claude", "fixture-session-0002", "checkpoints");
      mkdirSync(otherDir, { recursive: true });
      writeFileSync(join(otherDir, `${result.snapshot.envelope.hash.slice(7)}.json`), readFileSync(result.path));
      expect(() => listCheckpoints({ root, sessionId: "fixture-session-0002" })).toThrow(CorruptCheckpointError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["snapshot", "restore"] as const)("refuses a non-directory state path for %s", (command) => {
    const root = tempRoot();
    const statePath = join(root, "state");
    try {
      writeFileSync(statePath, "not a directory");
      const invoke = (): unknown => command === "snapshot"
        ? checkpoint({ root: statePath, sessionId: "fixture-session-0001", transcriptPath: fixture })
        : restore({ root: statePath, sessionId: "fixture-session-0001" });
      expect(invoke).toThrow(ContinuityRefusal);
      expect(invoke).toThrow(/State path is not a directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["snapshot", "restore"] as const)("refuses a non-directory intermediate state path for %s", (command) => {
    const root = tempRoot();
    const claude = join(root, "claude");
    try {
      writeFileSync(claude, "not a directory");
      const invoke = (): unknown => command === "snapshot"
        ? checkpoint({ root, sessionId: "fixture-session-0001", transcriptPath: fixture })
        : restore({ root, sessionId: "fixture-session-0001" });
      expect(invoke).toThrow(ContinuityRefusal);
      expect(invoke).toThrow(/State path is not a directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs PreCompact before SessionStart compact and injects idempotently", () => {
    const root = tempRoot();
    try {
      const input = { session_id: "fixture-session-0001", transcript_path: fixture, hook_event_name: "PreCompact" };
      expect(runHook(input, "precompact", { root })).toBe("{}");
      const output = JSON.parse(runHook({ ...input, hook_event_name: "SessionStart", source: "compact" }, "session-start", { root })) as { hookSpecificOutput?: { additionalContext?: string } };
      const pack = output.hookSpecificOutput?.additionalContext ?? "";
      expect(pack).toContain("[dcompact:");
      expect(injectPack(pack, pack).injected).toBe(false);
      const markerPath = join(root, "claude", "fixture-session-0001", "checkpoints", ".last-injected");
      expect(statSync(markerPath).mode & 0o777).toBe(0o600);
      expect(runHook({ ...input, hook_event_name: "SessionStart", source: "compact" }, "session-start", { root })).toBe("{}");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a corrupt injection marker as not-yet-injected", () => {
    const root = tempRoot();
    try {
      const input = { session_id: "fixture-session-0001", transcript_path: fixture };
      runHook(input, "precompact", { root });
      const expectedPack = restore({ root, sessionId: input.session_id }).pack;
      const markerPath = join(root, "claude", input.session_id, "checkpoints", ".last-injected");
      const marker = /^## dcompact context \[dcompact:[0-9a-f]{12}\]/m.exec(expectedPack)?.[0];
      expect(marker).toBeDefined();
      writeFileSync(markerPath, `${marker}\ncorrupt trailing state\n`);
      const output = runHook({ ...input, source: "compact" }, "session-start", { root });
      expect(output).toContain("additionalContext");
      expect(output).toContain(marker as string);
      expect(readFileSync(markerPath, "utf8")).toBe(`${marker}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("injects every fresh resume and starts a new compact epoch after each PreCompact", () => {
    const root = tempRoot();
    try {
      const input = { session_id: "fixture-session-0001", transcript_path: fixture };
      runHook(input, "precompact", { root });
      expect(runHook({ ...input, source: "compact" }, "session-start", { root })).toContain("additionalContext");
      expect(runHook({ ...input, source: "compact" }, "session-start", { root })).toBe("{}");
      expect(runHook({ ...input, source: "resume" }, "session-start", { root })).toContain("additionalContext");
      expect(runHook({ ...input, source: "compact" }, "session-start", { root })).toBe("{}");
      runHook(input, "precompact", { root });
      expect(runHook({ ...input, source: "compact" }, "session-start", { root })).toContain("additionalContext");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses private directories/files and refuses symlinked state paths", () => {
    const root = tempRoot();
    const linkedTarget = tempRoot();
    const nested = tempRoot();
    try {
      const result = checkpoint({ root, sessionId: "fixture-session-0001", transcriptPath: fixture });
      const claude = join(root, "claude");
      const session = join(claude, "fixture-session-0001");
      const checkpoints = join(session, "checkpoints");
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(claude).mode & 0o777).toBe(0o700);
      expect(statSync(session).mode & 0o777).toBe(0o700);
      expect(statSync(checkpoints).mode & 0o777).toBe(0o700);
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
      const bytes = readFileSync(result.path);
      const renamed = `${result.path}.real`;
      rmSync(result.path);
      writeFileSync(renamed, bytes);
      symlinkSync(renamed, result.path);
      expect(() => listCheckpoints({ root, sessionId: "fixture-session-0001" })).toThrow(ContinuityRefusal);

      const rootLink = join(linkedTarget, "store-link");
      symlinkSync(root, rootLink);
      expect(() => checkpoint({ root: rootLink, sessionId: "fixture-session-0001", transcriptPath: fixture })).toThrow();

      mkdirSync(join(nested, "claude"));
      symlinkSync(linkedTarget, join(nested, "claude", "fixture-session-0001"));
      expect(() => checkpoint({ root: nested, sessionId: "fixture-session-0001", transcriptPath: fixture })).toThrow(ContinuityRefusal);
      rmSync(join(nested, "claude"), { recursive: true, force: true });
      mkdirSync(join(nested, "claude", "fixture-session-0001"), { recursive: true });
      symlinkSync(linkedTarget, join(nested, "claude", "fixture-session-0001", "checkpoints"));
      expect(() => checkpoint({ root: nested, sessionId: "fixture-session-0001", transcriptPath: fixture })).toThrow(ContinuityRefusal);

      rmSync(nested, { recursive: true, force: true });
      checkpoint({ root: nested, sessionId: "fixture-session-0001", transcriptPath: fixture });
      const markerPath = join(nested, "claude", "fixture-session-0001", "checkpoints", ".last-injected");
      symlinkSync(linkedTarget, markerPath);
      expect(() => listCheckpoints({ root: nested, sessionId: "fixture-session-0001" })).toThrow(ContinuityRefusal);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(linkedTarget, { recursive: true, force: true });
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it("refuses a hash-consistent checkpoint with an unknown fact kind", () => {
    const root = tempRoot();
    try {
      const result = checkpoint({ root, sessionId: "fixture-session-0001", transcriptPath: fixture });
      const snapshot = JSON.parse(readFileSync(result.path, "utf8")) as { envelope: { hash: string }; payload: { facts: Array<Record<string, unknown>> } };
      snapshot.payload.facts[0]!.kind = "unknown.kind";
      snapshot.envelope.hash = payloadHash(snapshot.payload as unknown as Payload);
      writeFileSync(result.path, `${JSON.stringify(snapshot)}\n`);
      expect(() => listCheckpoints({ root, sessionId: "fixture-session-0001" })).toThrow(CorruptCheckpointError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["snapshot root", (snapshot: Record<string, unknown>) => { snapshot.extra = true; }],
    ["payload", (snapshot: Record<string, unknown>) => { (snapshot.payload as Record<string, unknown>).extra = true; }],
    ["transcript_lines", (snapshot: Record<string, unknown>) => { (snapshot.envelope as Record<string, unknown>).transcript_lines = -1; }],
    ["transcript_bytes", (snapshot: Record<string, unknown>) => { (snapshot.envelope as Record<string, unknown>).transcript_bytes = "bytes"; }],
  ] as const)("refuses invalid loaded checkpoint %s", (_label, mutate) => {
    const root = tempRoot();
    try {
      const result = checkpoint({ root, sessionId: "fixture-session-0001", transcriptPath: fixture });
      const snapshot = JSON.parse(readFileSync(result.path, "utf8")) as Record<string, unknown>;
      mutate(snapshot);
      writeFileSync(result.path, `${JSON.stringify(snapshot)}\n`);
      expect(() => listCheckpoints({ root, sessionId: "fixture-session-0001" })).toThrow(CorruptCheckpointError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails open when hook identity or transcript is unavailable", () => {
    const root = tempRoot();
    try {
      expect(runHook({}, "precompact", { root })).toBe("{}");
      expect(runHook({ session_id: "fixture-session-0001", transcript_path: join(root, "missing.jsonl") }, "precompact", { root })).toBe("{}");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
