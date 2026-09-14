import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CliIo } from "../src/cli.js";
import { run } from "../src/cli.js";
import { lineHash, payloadHash } from "../src/core/hash.js";
import type { Envelope, Fact, Payload, Snapshot } from "../src/core/types.js";
import { readManifest, writeManifest } from "../src/store/manifest.js";
import { sessionPaths } from "../src/store/paths.js";
import { listSnapshots, shortHash, writeSnapshot } from "../src/store/snapshot.js";
import type { SessionPaths } from "../src/store/types.js";
import { makeSnapshot, tempRoots } from "./helpers/store.js";

const temp = tempRoots();
afterEach(temp.clean);

interface RecordedIo {
  readonly stdout: string[];
  readonly stderr: string[];
}

function io(): RecordedIo {
  return { stdout: [], stderr: [] };
}

function callIo(output: RecordedIo): CliIo {
  return { stdout: (text) => output.stdout.push(text), stderr: (text) => output.stderr.push(text) };
}

function newSession(root: string, sessionId = "session-1"): SessionPaths {
  return sessionPaths({ adapter: "claude", sessionId, root });
}

/**
 * A `decision.stated` fact backed by exactly one real transcript line, so `verify --provenance`
 * has something meaningful to check — unlike `makeSnapshot`'s synthetic zero-hash evidence,
 * which no real transcript line could ever match.
 */
function snapshotWithTranscript(options: { readonly createdAt: string; readonly text: string; readonly transcriptPath: string; readonly line: string }): Snapshot {
  const fact: Fact = {
    kind: "decision.stated",
    key: options.text,
    at: { entry: 0, ts: null },
    attrs: { cue: "use" },
    evidence: [{ line: 1, sha256: lineHash(options.line) }],
    snippet: options.text,
    unbacked: false,
  };
  const payload: Payload = {
    facts: [fact],
    counters: { facts: 1, by_kind: { "decision.stated": 1 }, source_entries: 1, source_tool_calls: 0, unmapped_tool_calls: 0, coverage_ppm: 0, external_path_count: 0 },
    git: null,
    plan: null,
    path_base: "cwd",
    version: 1,
  };
  const envelope: Envelope = {
    schema_version: "1.0.0",
    canonicalization: 3,
    extractor_version: "0.1.0",
    created_at: options.createdAt,
    adapter: "claude",
    adapter_version: null,
    session_id: "session-1",
    transcript_path: options.transcriptPath,
    transcript_bytes: options.line.length,
    transcript_lines: 1,
    transcript_mtime: null,
    host: { os: "darwin", arch: "arm64", node: "20.0.0" },
    store: { cwd: "/tmp/repo", repo_root: null },
    degraded: [],
    previous_hash: null,
    duration_ms: 0,
    hash: payloadHash(payload),
  };
  return { envelope, payload };
}

function tamperSnippet(path: string, snippet: string): void {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  parsed.payload.facts[0].snippet = snippet;
  writeFileSync(path, JSON.stringify(parsed, null, 2));
}

describe("list", () => {
  it("reports emptiness rather than failing on a store with no snapshots yet", () => {
    const root = temp.next();
    const text = io();

    expect(run(["list", "--session", "nobody-here", "--store", root], callIo(text))).toBe(0);
    expect(text.stdout.join("")).toContain("snapshots: none");
    expect(text.stdout.join("")).toContain("quarantined: none");

    const json = io();
    expect(run(["list", "--session", "nobody-here", "--store", root, "--json"], callIo(json))).toBe(0);
    const parsed = JSON.parse(json.stdout.join(""));
    expect(parsed).toMatchObject({ session: "claude-nobody-here", snapshots: [], quarantined: [] });
    expect(parsed.manifest.rebuilt).toBe(false);
  });

  it("reports the right order, counts, and pinned flag for a populated session", () => {
    const root = temp.next();
    const session = newSession(root);
    const older = makeSnapshot({ createdAt: "2026-09-13T08:00:00Z", text: "first decision" });
    const newer = makeSnapshot({ createdAt: "2026-09-13T09:00:00Z", text: "second decision" });
    writeSnapshot({ session, snapshot: newer });
    writeSnapshot({ session, snapshot: older });

    // Simulate what `pin` (out of this read-only slice's scope) would record, so `list` has a
    // pin to report.
    const listed = listSnapshots(session);
    const read = readManifest(session, listed.entries);
    writeManifest(session, { ...read.manifest, snapshots: read.manifest.snapshots.map((entry) => (entry.hash === older.envelope.hash ? { ...entry, pinned: true } : entry)) });

    const json = io();
    expect(run(["list", "--session", "session-1", "--store", root, "--json"], callIo(json))).toBe(0);
    const parsed = JSON.parse(json.stdout.join(""));

    expect(parsed.snapshots.map((entry: { created_at: string }) => entry.created_at)).toEqual(["2026-09-13T08:00:00Z", "2026-09-13T09:00:00Z"]);
    expect(parsed.snapshots.map((entry: { pinned: boolean }) => entry.pinned)).toEqual([true, false]);
    expect(parsed.snapshots.map((entry: { facts: number }) => entry.facts)).toEqual([1, 1]);
    expect(parsed.snapshots[0].short).toBe(shortHash(older.envelope.hash));
  });

  it("surfaces a quarantined snapshot and does not count it as usable", () => {
    const root = temp.next();
    const session = newSession(root);
    const { path } = writeSnapshot({ session, snapshot: makeSnapshot() });
    tamperSnippet(path, "tampered");

    const json = io();
    expect(run(["list", "--session", "session-1", "--store", root, "--json"], callIo(json))).toBe(0);
    const parsed = JSON.parse(json.stdout.join(""));

    expect(parsed.snapshots).toEqual([]);
    expect(parsed.quarantined).toHaveLength(1);
    expect(parsed.quarantined[0].code).toBe("hash-mismatch");
  });
});

describe("show", () => {
  it("renders the expected snapshot's envelope, payload summary, and pack", () => {
    const root = temp.next();
    const session = newSession(root);
    const snapshot = makeSnapshot({ text: "use bounded retry, not infinite backoff" });
    writeSnapshot({ session, snapshot });
    const id = shortHash(snapshot.envelope.hash);

    const json = io();
    expect(run(["show", "--session", "session-1", "--snapshot", id, "--store", root, "--json"], callIo(json))).toBe(0);
    const parsed = JSON.parse(json.stdout.join(""));

    expect(parsed.id).toBe(id);
    expect(parsed.envelope.hash).toBe(snapshot.envelope.hash);
    expect(parsed.payload.facts).toHaveLength(1);
    expect(parsed.payload.facts[0].snippet).toBe("use bounded retry, not infinite backoff");
    expect(parsed.pack).toContain("use bounded retry, not infinite backoff");

    const text = io();
    expect(run(["show", "--session", "session-1", "--snapshot", id, "--store", root], callIo(text))).toBe(0);
    expect(text.stdout.join("")).toContain("--- pack ---");
    expect(text.stdout.join("")).toContain("use bounded retry, not infinite backoff");
  });

  it("refuses an unknown snapshot id with an actionable message", () => {
    const root = temp.next();
    const session = newSession(root);
    writeSnapshot({ session, snapshot: makeSnapshot() });
    const output = io();

    const status = run(["show", "--session", "session-1", "--snapshot", "deadbeefcafe", "--store", root], callIo(output));

    expect(status).toBe(4);
    expect(output.stderr.join("")).toContain('No snapshot "deadbeefcafe"');
    expect(output.stderr.join("")).toContain("dcompact list --session session-1");
  });
});

describe("verify", () => {
  it("passes on an intact store", () => {
    const root = temp.next();
    const session = newSession(root);
    writeSnapshot({ session, snapshot: makeSnapshot({ createdAt: "2026-09-13T08:00:00Z", text: "first" }) });
    writeSnapshot({ session, snapshot: makeSnapshot({ createdAt: "2026-09-13T09:00:00Z", text: "second" }) });
    const output = io();

    const status = run(["verify", "--session", "session-1", "--store", root], callIo(output));

    expect(status).toBe(0);
    expect(output.stdout.join("")).toContain("integrity: ok");
  });

  it("fails with the integrity exit code on a tampered payload", () => {
    const root = temp.next();
    const session = newSession(root);
    const { path } = writeSnapshot({ session, snapshot: makeSnapshot() });
    tamperSnippet(path, "tampered");
    const output = io();

    const status = run(["verify", "--session", "session-1", "--store", root], callIo(output));

    expect(status).toBe(3);
    expect(output.stdout.join("")).toContain("integrity: FAILED");
    expect(output.stdout.join("")).toContain("hash-mismatch");
  });

  describe("--provenance", () => {
    function setup(): { readonly root: string; readonly transcriptPath: string; readonly line: string } {
      const root = temp.next();
      const transcriptDir = mkdtempSync(join(tmpdir(), "dcompact-og58-transcript-"));
      const transcriptPath = join(transcriptDir, "transcript.jsonl");
      const line = '{"line":"one"}\n';
      writeFileSync(transcriptPath, line);
      return { root, transcriptPath, line };
    }

    it("reports facts as backed when the transcript is intact", () => {
      const { root, transcriptPath, line } = setup();
      const session = newSession(root);
      writeSnapshot({ session, snapshot: snapshotWithTranscript({ createdAt: "2026-09-13T08:00:00Z", text: "d", transcriptPath, line }) });
      const output = io();

      const status = run(["verify", "--session", "session-1", "--store", root, "--provenance", "--json"], callIo(output));
      const parsed = JSON.parse(output.stdout.join(""));

      expect(status).toBe(0);
      expect(parsed.checked[0].provenance.counts).toEqual({ backed: 1, drifted: 0, unbacked: 0 });
    });

    it("reports facts as unbacked, never silently verified, when the transcript is gone", () => {
      const { root, transcriptPath, line } = setup();
      const session = newSession(root);
      writeSnapshot({ session, snapshot: snapshotWithTranscript({ createdAt: "2026-09-13T08:00:00Z", text: "d", transcriptPath, line }) });
      unlinkSync(transcriptPath);
      const output = io();

      const status = run(["verify", "--session", "session-1", "--store", root, "--provenance", "--json"], callIo(output));
      const parsed = JSON.parse(output.stdout.join(""));

      // The payload itself is untouched — only its provenance is unverifiable — so this is not
      // the corrupt-payload integrity failure; it is an honestly reported degraded check.
      expect(status).toBe(0);
      expect(parsed.checked[0].provenance.transcriptReadable).toBe(false);
      expect(parsed.checked[0].provenance.counts).toEqual({ backed: 0, drifted: 0, unbacked: 1 });
    });

    it("reports drifted facts, never silently verified, when the transcript line changed", () => {
      const { root, transcriptPath, line } = setup();
      const session = newSession(root);
      writeSnapshot({ session, snapshot: snapshotWithTranscript({ createdAt: "2026-09-13T08:00:00Z", text: "d", transcriptPath, line }) });
      writeFileSync(transcriptPath, '{"line":"changed"}\n');
      const output = io();

      const status = run(["verify", "--session", "session-1", "--store", root, "--provenance", "--json"], callIo(output));
      const parsed = JSON.parse(output.stdout.join(""));

      expect(status).toBe(0);
      expect(parsed.checked[0].provenance.transcriptReadable).toBe(true);
      expect(parsed.checked[0].provenance.counts).toEqual({ backed: 0, drifted: 1, unbacked: 0 });
    });
  });
});

describe("a missing --session is refused for every store command", () => {
  it.each([["list"], ["show"], ["verify"]])("%s", (command) => {
    const root = temp.next();
    const output = io();

    const status = run([command, "--store", root], callIo(output));

    expect(status).toBe(2);
    expect(output.stderr.join("")).toContain("requires an explicit --session <id>");
  });
});

describe("--store", () => {
  it("resolves a not-yet-created session directory instead of refusing, matching an empty store", () => {
    const root = join(temp.next(), "not-created-yet");
    const output = io();

    const status = run(["list", "--session", "session-1", "--store", root], callIo(output));

    expect(status).toBe(0);
    expect(output.stdout.join("")).toContain("snapshots: none");
  });
});
