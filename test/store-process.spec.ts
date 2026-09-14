import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { systemClock } from "../src/core/clock.js";
import { DEFAULT_LOCK_WAIT_MS, LOCK_OBSERVATION_INTERVAL_MS, acquireLock } from "../src/store/lock.js";
import { readManifest } from "../src/store/manifest.js";
import { sessionPaths } from "../src/store/paths.js";
import { listSnapshots, snapshotFileName, writeSnapshot } from "../src/store/snapshot.js";
import type { SessionPaths } from "../src/store/types.js";
import { makeSnapshot, tempRoots, usableSnapshot } from "./helpers/store.js";
import { CHILD_TIMEOUT_MS, childReport, closeStoreBuild, pollUntil, startChild, within } from "./helpers/store-process.js";

const temp = tempRoots();
afterEach(temp.clean);
afterAll(closeStoreBuild);

const CREATED_AT = "2026-09-13T08:41:09Z";

/**
 * Big enough that the temp file exists for far longer than it takes to notice it, so the parent's
 * kill lands inside the write rather than after the rename. The window is the write itself, and
 * the parent is watching for the file the write creates — not sleeping and hoping.
 */
const CRASH_PAYLOAD_BYTES = 16 * 1024 * 1024;

function newSession(sessionId: string): SessionPaths {
  return sessionPaths({ adapter: "claude", sessionId, root: temp.next() });
}

/** The names directly under the snapshot directory, which is what a store must never misread. */
function snapshotDirectoryNames(session: SessionPaths): string[] {
  return existsSync(session.snapshots) ? readdirSync(session.snapshots) : [];
}

function finalSnapshotNames(session: SessionPaths): string[] {
  return snapshotDirectoryNames(session).filter((name) => name.endsWith(".json"));
}

describe("crash atomicity", () => {
  it("leaves no partial or unreadable snapshot under a final name when the writer is killed mid-write", async () => {
    const session = newSession("crash-1");
    const run = startChild("crash", { root: session.root, sessionId: session.sessionId, createdAt: CREATED_AT, text: "in flight", padBytes: CRASH_PAYLOAD_BYTES });

    // The writer's own temp file is the observable event that says "a write is in flight".
    const tempName = `-${run.pid}`;
    await pollUntil(() => snapshotDirectoryNames(session).some((name) => name.endsWith(tempName)), CHILD_TIMEOUT_MS, "the writer's temp file");
    run.child.kill("SIGSTOP");

    // Frozen inside the write: the bytes are in a temp file that is not a snapshot, and no final
    // name exists yet. This is the crash point, forced rather than hoped for.
    const frozen = snapshotDirectoryNames(session);
    expect(frozen.filter((name) => name.endsWith(".json"))).toEqual([]);
    expect(frozen).toHaveLength(1);

    run.child.kill("SIGKILL");
    const result = await within(run.done, CHILD_TIMEOUT_MS, "the killed writer");
    expect(result.signal).toBe("SIGKILL");

    // The store holds no partial snapshot: the write either never appeared, or it is complete and
    // hash-valid. A partial file under a final name is exactly what atomic rename exists to prevent.
    const listed = listSnapshots(session);
    expect(listed.snapshots).toEqual([]);
    expect(listed.quarantined).toEqual([]);
    expect(finalSnapshotNames(session)).toEqual([]);
    // The in-flight write is still there, and it is inert because it is not a snapshot name.
    expect(snapshotDirectoryNames(session)).toEqual(frozen);

    // The store is still usable afterwards, with the crash litter in place.
    const snapshot = makeSnapshot({ createdAt: "2026-09-13T08:42:00Z", text: "after the crash", sessionId: session.sessionId });
    const written = writeSnapshot({ session, snapshot });

    expect(usableSnapshot(written.path)).toEqual(snapshot);
    expect(usableSnapshot(join(session.snapshots, snapshotFileName(snapshot.envelope)))).toEqual(snapshot);
    const after = listSnapshots(session);
    expect(after.quarantined).toEqual([]);
    expect(after.snapshots.map((entry) => entry.envelope.hash)).toEqual([snapshot.envelope.hash]);
    expect(readManifest(session, after.entries).rebuilt).toBe(false);
  });

  it("does not block the next writer when a process is killed holding the lock", async () => {
    const session = newSession("crash-2");
    const run = startChild("crash", { root: session.root, sessionId: session.sessionId, createdAt: CREATED_AT, text: "in flight", padBytes: CRASH_PAYLOAD_BYTES, lock: true });

    await pollUntil(() => snapshotDirectoryNames(session).some((name) => name.endsWith(`-${run.pid}`)), CHILD_TIMEOUT_MS, "the writer's temp file");
    run.child.kill("SIGSTOP");
    expect(existsSync(session.lock)).toBe(true);
    run.child.kill("SIGKILL");
    expect((await within(run.done, CHILD_TIMEOUT_MS, "the killed writer")).signal).toBe("SIGKILL");

    // The dead holder's record is younger than the stale window, so it is respected rather than
    // broken — and the store is not blocked by it: the next writer waits its bounded window out and
    // still writes a complete snapshot.
    const startedAt = Date.now();
    const lock = acquireLock({ session, clock: systemClock });
    const waitedMs = Date.now() - startedAt;

    expect(lock.held).toBe(false);
    expect(lock.broken).toBeNull();
    expect(lock.respected?.pid).toBe(run.pid);
    expect(waitedMs).toBeLessThanOrEqual(DEFAULT_LOCK_WAIT_MS + LOCK_OBSERVATION_INTERVAL_MS + 500);

    const snapshot = makeSnapshot({ createdAt: "2026-09-13T08:42:00Z", text: "written after the holder died", sessionId: session.sessionId });
    const written = writeSnapshot({ session, snapshot });
    lock.release();

    expect(written.created).toBe(true);
    expect(usableSnapshot(written.path)).toEqual(snapshot);
    expect(readManifest(session, listSnapshots(session).entries).rebuilt).toBe(false);
  });
});

describe("concurrent writers", () => {
  it("has two processes write one session at once, leaving two valid distinct snapshots and a consistent index", async () => {
    const session = newSession("race-1");
    // The barrier lives outside the store, so it cannot be mistaken for store state.
    const barrier = mkdtempSync(join(tmpdir(), "dcompact-og58-barrier-"));
    const meet = (name: string): { readonly ready: string; readonly await: string } => ({
      ready: join(barrier, `${name}-ready`),
      await: join(barrier, `${name === "a" ? "b" : "a"}-ready`),
    });
    try {
      // Both writers wait for each other before touching the store, and both are told the same
      // creation instant, so the only thing that can separate their snapshots is their own payload.
      const first = startChild("concurrent", { root: session.root, sessionId: session.sessionId, createdAt: CREATED_AT, text: "first decision", ...meet("a") });
      const second = startChild("concurrent", { root: session.root, sessionId: session.sessionId, createdAt: CREATED_AT, text: "second decision", ...meet("b") });
      const results = await Promise.all([within(first.done, CHILD_TIMEOUT_MS, "the first writer"), within(second.done, CHILD_TIMEOUT_MS, "the second writer")]);

      for (const result of results) {
        expect(result.signal).toBeNull();
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
      }
      const reports = [childReport(results[0], "the first writer"), childReport(results[1], "the second writer")];
      // Exactly one of them created the lock first; the other either took it after the release or
      // waited its window out. Either way at least one writer held it, and neither failed.
      expect(reports.some((report) => report.held === true)).toBe(true);
      for (const report of reports) expect(report.path).toEqual(expect.any(String));

      const paths = reports.map((report) => report.path as string);
      expect(new Set(paths).size).toBe(2);
      for (const path of paths) expect(existsSync(path)).toBe(true);

      // Two distinct snapshots, each individually valid, both from the same instant.
      const listed = listSnapshots(session);
      expect(listed.quarantined).toEqual([]);
      expect(listed.snapshots).toHaveLength(2);
      expect(new Set(listed.snapshots.map((snapshot) => snapshot.envelope.hash)).size).toBe(2);
      expect(listed.snapshots.every((snapshot) => snapshot.envelope.created_at === CREATED_AT && snapshot.envelope.session_id === session.sessionId)).toBe(true);
      expect(finalSnapshotNames(session).sort()).toEqual(paths.map((path) => basename(path)).sort());
      for (const snapshot of listed.snapshots) expect(usableSnapshot(join(session.snapshots, snapshotFileName(snapshot.envelope)))).toEqual(snapshot);

      // The index describes exactly the files on disk, and no claim outlives its writer.
      const read = readManifest(session, listed.entries);
      expect(read.rebuilt).toBe(false);
      expect(read.manifest.snapshots.map((entry) => entry.hash)).toEqual(listed.entries.map((entry) => entry.hash));
      expect(read.manifest.snapshots).toHaveLength(2);
      expect(read.manifest.lock).toBeNull();
      expect(existsSync(session.lock)).toBe(false);
      expect(snapshotDirectoryNames(session).filter((name) => !name.endsWith(".json"))).toEqual([]);
    } finally {
      rmSync(barrier, { recursive: true, force: true });
    }
  });

  it("keeps both snapshots when a writer starts while the other still holds the lock", async () => {
    const session = newSession("race-2");
    // Drive the boundary explicitly: this process holds the lock for real, so the child's acquire
    // has a live, fresh holder to respect — the contended path, without racing for it.
    const holder = acquireLock({ session, clock: systemClock });
    expect(holder.held).toBe(true);
    const claim: unknown = JSON.parse(readFileSync(session.lock, "utf8"));

    const run = startChild("concurrent", { root: session.root, sessionId: session.sessionId, createdAt: CREATED_AT, text: "the child's decision" });
    const result = await within(run.done, CHILD_TIMEOUT_MS, "the child writer");
    const report = childReport(result, "the child writer");

    expect(result.code).toBe(0);
    expect(report.held).toBe(false);
    expect(report.respected).toEqual(claim);
    expect(report.broken).toBeNull();

    const snapshot = makeSnapshot({ createdAt: CREATED_AT, text: "the holder's decision", sessionId: session.sessionId });
    const written = writeSnapshot({ session, snapshot });
    holder.release();

    const listed = listSnapshots(session);
    expect(listed.quarantined).toEqual([]);
    expect(listed.snapshots).toHaveLength(2);
    expect(new Set(listed.snapshots.map((entry) => entry.envelope.hash)).size).toBe(2);
    expect(new Set([written.path, report.path as string]).size).toBe(2);
    expect(usableSnapshot(written.path)).toEqual(snapshot);
    expect(readManifest(session, listed.entries).rebuilt).toBe(false);
    expect(existsSync(session.lock)).toBe(false);
  });
});