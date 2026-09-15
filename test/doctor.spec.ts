import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readClaudeTranscript } from "../src/adapters/mappers.js";
import { run } from "../src/cli.js";
import type { CliIo } from "../src/cli.js";
import { fixedClock } from "../src/core/clock.js";
import { payloadHash } from "../src/core/hash.js";
import { minimumPackBytes } from "../src/core/pack.js";
import type { DegradedState, Envelope, Snapshot } from "../src/core/types.js";
import { doctor, doctorExitCode } from "../src/doctor.js";
import type { DoctorReport } from "../src/doctor.js";
import { ensureSessionDirectories, sessionPaths } from "../src/store/paths.js";
import { writeSnapshot } from "../src/store/snapshot.js";
import type { ManifestLock, SessionPaths } from "../src/store/types.js";
import { utcInstantFrom } from "../src/store/types.js";
import { makeSnapshot, tempRoots } from "./helpers/store.js";

const temp = tempRoots();
afterEach(temp.clean);

const T0 = Date.parse("2026-09-13T08:41:09Z");

function newSession(sessionId = "session-1"): SessionPaths {
  return sessionPaths({ adapter: "claude", sessionId, root: temp.next() });
}

/** The pid of a process that has already exited, so a lock holder can name an owner that is gone. */
function deadPid(): number {
  const probe = spawnSync(process.execPath, ["-e", ""]);
  if (probe.pid === undefined) throw new Error("could not start a probe process");
  return probe.pid;
}

function source(lines: readonly object[]): Uint8Array {
  return new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n"));
}

/** Build a snapshot the way the checkpoint pipeline does, from real transcript bytes, so
 * schema-drift/extraction-empty come from the actual extraction path rather than a hand-set flag. */
function snapshotFromTranscript(session: SessionPaths, bytes: Uint8Array, createdAt: string): Snapshot {
  const read = readClaudeTranscript(bytes);
  const parse = read.parse;
  const envelope: Envelope = {
    schema_version: "1.0.0",
    canonicalization: 3,
    extractor_version: "0.1.0",
    created_at: createdAt,
    adapter: "claude",
    adapter_version: parse.session.version,
    session_id: session.sessionId,
    transcript_path: null,
    transcript_bytes: bytes.byteLength,
    transcript_lines: 1,
    transcript_mtime: null,
    host: { os: "darwin", arch: "arm64", node: "20.0.0" },
    store: { cwd: parse.session.cwd ?? "", repo_root: null },
    degraded: [...read.degraded],
    previous_hash: null,
    duration_ms: 0,
    hash: payloadHash(read.payload),
  };
  return { envelope, payload: read.payload };
}

function cliCapture(argv: readonly string[]): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) };
  const status = run(argv, io);
  return { status, stdout, stderr };
}

describe("doctor: healthy store", () => {
  it("reports ok, the right counts, and the right newest snapshot", () => {
    const session = newSession();
    const older = makeSnapshot({ createdAt: "2026-09-13T08:41:09Z", text: "a decision that persists across checkpoints" });
    const newer = makeSnapshot({ createdAt: "2026-09-13T08:42:09Z", text: "a decision that persists across checkpoints" });
    writeSnapshot({ session, snapshot: older });
    writeSnapshot({ session, snapshot: newer });

    const report = doctor({ adapter: session.adapter, sessionId: session.sessionId, root: session.root, clock: fixedClock(T0) });

    expect(report.store.usable).toBe(true);
    expect(report.store.refusal).toBeNull();
    expect(report.manifest).toEqual({ rebuilt: false, reason: null });
    expect(report.snapshots.count).toBe(2);
    expect(report.snapshots.newest).toEqual({ id: `${newer.envelope.created_at}|${newer.envelope.hash}`, created_at: newer.envelope.created_at, hash: newer.envelope.hash });
    expect(report.quarantined).toEqual([]);
    expect(report.lock).toEqual({ held: true, respected: null, broken: null, waited_ms: 0 });
    expect(report.adapter_health.coverage_ppm).toBe(0);
    expect(report.adapter_health.unmapped_tool_calls).toBe(0);
    expect(report.adapter_health.by_kind).toEqual({ "decision.stated": 1 });
    expect(report.adapter_health.by_tool_name).toBeNull();
    expect(report.degraded).toEqual([]);
    expect(doctorExitCode(report)).toBe(0);
  });

  it("reports ok for a session that was never checkpointed, without creating snapshot data", () => {
    const session = newSession();

    const report = doctor({ adapter: session.adapter, sessionId: session.sessionId, root: session.root, clock: fixedClock(T0) });

    expect(report.store.usable).toBe(true);
    expect(report.snapshots).toEqual({ count: 0, newest: null });
    expect(report.adapter_health).toEqual({ coverage_ppm: null, unmapped_tool_calls: null, by_kind: null, by_tool_name: null });
    expect(report.degraded).toEqual([]);
    expect(doctorExitCode(report)).toBe(0);
  });
});

describe("doctor: manifest health", () => {
  it("reports the rebuild when the manifest was deleted", () => {
    const session = newSession();
    writeSnapshot({ session, snapshot: makeSnapshot() });
    rmSync(session.manifest);

    const report = doctor({ adapter: session.adapter, sessionId: session.sessionId, root: session.root, clock: fixedClock(T0) });

    expect(report.manifest).toEqual({ rebuilt: true, reason: "missing" });
    expect(report.snapshots.count).toBe(1);
    expect(doctorExitCode(report)).toBe(0);
  });
});

describe("doctor: quarantine", () => {
  it("reports a corrupted snapshot as quarantined with its reason, and excludes it from usable counts", () => {
    const session = newSession();
    const written = writeSnapshot({ session, snapshot: makeSnapshot() });
    const tampered = JSON.parse(readFileSync(written.path, "utf8"));
    tampered.payload.facts[0].snippet = "tampered after the hash was computed";
    writeFileSync(written.path, JSON.stringify(tampered, null, 2));

    const report = doctor({ adapter: session.adapter, sessionId: session.sessionId, root: session.root, clock: fixedClock(T0) });

    expect(report.snapshots).toEqual({ count: 0, newest: null });
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantined[0]?.code).toBe("hash-mismatch");
    expect(report.quarantined[0]?.reason).toContain("payload hashes to");
    expect(report.quarantined[0]?.path).toBe(written.path);
    expect(doctorExitCode(report)).toBe(3);
  });
});

describe("doctor: lock", () => {
  it("reports a broken stale lock and the evidence kept for it", () => {
    const session = newSession();
    ensureSessionDirectories(session);
    const holder: ManifestLock = { pid: deadPid(), host: hostname(), started_at: utcInstantFrom(T0) };
    writeFileSync(session.lock, `${JSON.stringify(holder, null, 2)}\n`);

    const report = doctor({ adapter: session.adapter, sessionId: session.sessionId, root: session.root, clock: fixedClock(T0 + 31_000) });

    expect(report.lock).not.toBeNull();
    expect(report.lock?.broken).toEqual({ holder, reason: "stale", evidence_path: `${session.lock}.broken`, age_ms: 31_000 });
    expect(readFileSync(`${session.lock}.broken`, "utf8")).toBe(`${JSON.stringify(holder, null, 2)}\n`);
    expect(doctorExitCode(report)).toBe(4);
  });
});

describe("doctor: store availability", () => {
  it("reports unavailable:store for an unreadable/absent store rather than throwing", () => {
    const session = newSession();
    ensureSessionDirectories({ ...session });
    rmSync(session.session, { recursive: true, force: true });
    writeFileSync(session.session, "occupied by a file, not a directory");

    const report = doctor({ adapter: session.adapter, sessionId: session.sessionId, root: session.root, clock: fixedClock(T0) });

    expect(report.store.usable).toBe(false);
    expect(report.store.refusal).toContain("not a directory");
    expect(report.manifest).toBeNull();
    expect(report.snapshots).toEqual({ count: 0, newest: null });
    expect(report.lock).toBeNull();
    expect(report.degraded).toEqual(["unavailable:store"]);
    expect(doctorExitCode(report)).toBe(1);
  });
});

describe("doctor: extraction health via the real pipeline", () => {
  it("reports extraction-empty for a recognized transcript that yields no facts", () => {
    const session = newSession();
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [] } },
    ]);
    writeSnapshot({ session, snapshot: snapshotFromTranscript(session, bytes, "2026-09-13T08:41:09Z") });

    const report = doctor({ adapter: session.adapter, sessionId: session.sessionId, root: session.root, clock: fixedClock(T0) });

    expect(report.degraded).toContain("extraction-empty");
    expect(doctorExitCode(report)).toBe(4);
  });

  it("reports schema-drift for an unknown record shape", () => {
    const session = newSession();
    const bytes = source([
      { type: "assistant", uuid: "a", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/fixture/repo/a.md" } }] } },
      { type: "brand-new-shape", uuid: "b", timestamp: null },
      { type: "user", uuid: "c", timestamp: null, cwd: "/fixture/repo", sessionId: "s", message: { role: "user", content: [{ tool_use_id: "c1", type: "tool_result", content: "ok" }] } },
    ]);
    writeSnapshot({ session, snapshot: snapshotFromTranscript(session, bytes, "2026-09-13T08:41:09Z") });

    const report = doctor({ adapter: session.adapter, sessionId: session.sessionId, root: session.root, clock: fixedClock(T0) });

    expect(report.degraded).toContain("schema-drift");
    expect(doctorExitCode(report)).toBe(4);
  });
});

describe("doctor: provenance", () => {
  it("reports provenance-broken when an earlier checkpoint's fact is absent from the newest", () => {
    const session = newSession();
    writeSnapshot({ session, snapshot: makeSnapshot({ createdAt: "2026-09-13T08:41:09Z", text: "only ever seen once" }) });
    writeSnapshot({ session, snapshot: makeSnapshot({ createdAt: "2026-09-13T08:42:09Z", text: "the newest fact" }) });

    const report = doctor({ adapter: session.adapter, sessionId: session.sessionId, root: session.root, clock: fixedClock(T0) });

    expect(report.degraded).toContain("provenance-broken");
    expect(doctorExitCode(report)).toBe(3);
  });
});

describe("doctor: budget", () => {
  it("reports budget-exceeded when the merged pack cannot hold any fact at the configured budget", () => {
    const session = newSession();
    const snapshot = makeSnapshot();
    writeSnapshot({ session, snapshot });
    const tooSmall = minimumPackBytes(snapshot.payload, { degraded: ["budget-exceeded"] });

    const report = doctor({ adapter: session.adapter, sessionId: session.sessionId, root: session.root, clock: fixedClock(T0), maxBytes: tooSmall });

    expect(report.degraded).toContain("budget-exceeded");
    expect(doctorExitCode(report)).toBe(4);
  });
});

describe("doctor: unreachable states (not producible by any path in this checkout)", () => {
  it("documents that internal-error, unavailable:agent-not-installed, untrusted:hook-pending-review, and no-pre-compaction-hook have no producer here", () => {
    // No install/uninstall command exists (P10), so hook-presence and hook-trust detection have
    // no data source; no fault-injection boundary exists (P12), so internal-error has no honest
    // trigger either. This test exists so the gap is asserted rather than merely claimed in prose:
    // a future producer added without updating this test is a signal the claim went stale.
    const session = newSession();
    writeSnapshot({ session, snapshot: makeSnapshot() });
    const report = doctor({ adapter: session.adapter, sessionId: session.sessionId, root: session.root, clock: fixedClock(T0) });
    const unreachable: readonly DegradedState[] = ["internal-error", "unavailable:agent-not-installed", "untrusted:hook-pending-review", "no-pre-compaction-hook"];
    for (const state of unreachable) expect(report.degraded).not.toContain(state);
  });
});

describe("doctor: never guesses a session", () => {
  it("refuses a doctor invocation without an explicit --session", () => {
    const root = mkdtempSync(join(tmpdir(), "dcompress-doctor-cli-"));
    try {
      const result = cliCapture(["doctor", "--store", root]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("no session is ever chosen for you");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("doctor: CLI wiring", () => {
  it("prints stable, parseable --json with no unexpected host path text and the documented exit code", () => {
    const root = mkdtempSync(join(tmpdir(), "dcompress-doctor-cli-"));
    try {
      const session = sessionPaths({ adapter: "claude", sessionId: "session-1", root });
      writeSnapshot({ session, snapshot: makeSnapshot() });

      const result = cliCapture(["doctor", "--session", "session-1", "--store", root, "--json"]);
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout) as DoctorReport;
      expect(report.store.root).toBe(session.root);
      expect(report.session_id).toBe("session-1");
      expect(report.degraded).toEqual([]);
      // Stable and parseable twice over: the same store yields byte-identical JSON.
      const again = cliCapture(["doctor", "--session", "session-1", "--store", root, "--json"]);
      expect(again.stdout).toBe(result.stdout);
      // No host path beyond the store location the user explicitly named leaks into the report.
      expect(result.stdout).not.toContain("/fixture/repo");
      expect(result.stdout).not.toContain(process.cwd());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints human-readable text by default and exits operational-failure for an unusable store", () => {
    const root = mkdtempSync(join(tmpdir(), "dcompress-doctor-cli-"));
    try {
      const session = sessionPaths({ adapter: "claude", sessionId: "session-1", root });
      ensureSessionDirectories(session);
      rmSync(session.session, { recursive: true, force: true });
      writeFileSync(session.session, "occupied by a file, not a directory");

      const result = cliCapture(["doctor", "--session", "session-1", "--store", root]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("usable: false");
      expect(result.stdout).toContain("unavailable:store");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
