import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixedClock, systemClock } from "../src/core/clock.js";
import { DEFAULT_LOCK_WAIT_MS, LOCK_OBSERVATION_INTERVAL_MS, acquireLock } from "../src/store/lock.js";
import { readManifest } from "../src/store/manifest.js";
import { ensureSessionDirectories, sessionPaths } from "../src/store/paths.js";
import { listSnapshots, snapshotFileName, writeSnapshot } from "../src/store/snapshot.js";
import type { ManifestLock, SessionPaths } from "../src/store/types.js";
import { utcInstantFrom } from "../src/store/types.js";
import { makeSnapshot, refusalFrom, tempRoots, usableSnapshot } from "./helpers/store.js";

const temp = tempRoots();
afterEach(temp.clean);

/** A fixed instant every injected clock is built from; nothing here reads the wall clock. */
const T0 = Date.parse("2026-09-13T08:41:09Z");

function newSession(sessionId = "session-1"): SessionPaths {
  return sessionPaths({ adapter: "claude", sessionId, root: temp.next() });
}

/**
 * The pid of a process that has already exited, so a holder record can name an owner that is
 * genuinely gone. A pid is reused eventually; not within the microseconds this test needs it dead.
 */
function deadPid(): number {
  const probe = spawnSync(process.execPath, ["-e", ""]);
  if (probe.pid === undefined) throw new Error("could not start a probe process");
  return probe.pid;
}

/** A holder record written the way a writer that was killed mid-write would leave it. */
function leaveLock(session: SessionPaths, holder: ManifestLock): void {
  ensureSessionDirectories(session);
  writeFileSync(session.lock, `${JSON.stringify(holder, null, 2)}\n`);
}

function storedLock(session: SessionPaths): unknown {
  return JSON.parse(readFileSync(session.manifest, "utf8")).lock;
}

function storedManifest(session: SessionPaths): Record<string, unknown> {
  return JSON.parse(readFileSync(session.manifest, "utf8"));
}

describe("stale locks", () => {
  it("breaks a lock that is old and whose pid is gone, reports it, and keeps the record it broke", () => {
    const session = newSession();
    const holder: ManifestLock = { pid: deadPid(), host: hostname(), started_at: utcInstantFrom(T0) };
    leaveLock(session, holder);

    const lock = acquireLock({ session, clock: fixedClock(T0 + 31_000), sleep: () => {} });

    expect(lock.held).toBe(true);
    expect(lock.respected).toBeNull();
    expect(lock.broken).toEqual({ holder, reason: "stale", evidence_path: `${session.lock}.broken`, age_ms: 31_000 });
    expect(lock.waited_ms).toBe(0);
    // The break is recorded, not merely reported: the broken record is still readable beside the lock.
    expect(JSON.parse(readFileSync(`${session.lock}.broken`, "utf8"))).toEqual(holder);
    expect(JSON.parse(readFileSync(session.lock, "utf8"))).toEqual({ pid: process.pid, host: hostname(), started_at: utcInstantFrom(T0 + 31_000) });
    expect(storedLock(session)).toEqual({ pid: process.pid, host: hostname(), started_at: utcInstantFrom(T0 + 31_000) });

    lock.release();
    expect(existsSync(session.lock)).toBe(false);
    expect(storedLock(session)).toBeNull();
  });

  it("keeps a second broken record instead of overwriting the first", () => {
    const session = newSession();
    const holder: ManifestLock = { pid: deadPid(), host: hostname(), started_at: utcInstantFrom(T0) };
    leaveLock(session, holder);
    writeFileSync(`${session.lock}.broken`, "an earlier break");

    const lock = acquireLock({ session, clock: fixedClock(T0 + 31_000), sleep: () => {} });

    expect(lock.broken?.evidence_path).toBe(`${session.lock}.broken.1`);
    expect(readFileSync(`${session.lock}.broken`, "utf8")).toBe("an earlier break");
  });

  it.each([
    ["a truncated record", "{ truncated"],
    ["a JSON value that is not a holder record", '{"pid": 1}'],
  ])("breaks a lock file it cannot read (%s) rather than blocking on it", (_case, contents) => {
    const session = newSession();
    ensureSessionDirectories(session);
    writeFileSync(session.lock, contents);

    const lock = acquireLock({ session, clock: fixedClock(T0), sleep: () => {} });

    expect(lock.held).toBe(true);
    expect(lock.broken).toEqual({ holder: null, reason: "unreadable", evidence_path: `${session.lock}.broken`, age_ms: null });
    expect(readFileSync(`${session.lock}.broken`, "utf8")).toBe(contents);
  });

  it("refuses a symlinked lock instead of following it", () => {
    const session = newSession();
    ensureSessionDirectories(session);
    const elsewhere = join(session.root, "elsewhere.json");
    const alreadyThere = JSON.stringify({ pid: process.pid, host: hostname(), started_at: utcInstantFrom(T0) });
    writeFileSync(elsewhere, alreadyThere);
    symlinkSync(elsewhere, session.lock);

    expect(refusalFrom(() => acquireLock({ session, clock: fixedClock(T0), sleep: () => {} })).code).toBe("symlink-state");
    expect(readFileSync(elsewhere, "utf8")).toBe(alreadyThere);
  });
});

describe("held locks", () => {
  it("respects a fresh lock held by a live pid, waits its window out, then writes its own distinct snapshot", () => {
    const session = newSession();
    const holder = acquireLock({ session, clock: fixedClock(T0) });
    expect(holder.held).toBe(true);
    const held: ManifestLock = { pid: process.pid, host: hostname(), started_at: utcInstantFrom(T0) };
    const holderWritten = writeSnapshot({ session, snapshot: makeSnapshot({ createdAt: utcInstantFrom(T0 + 1_000), text: "the holder's decision" }) });

    const startedAt = Date.now();
    const waiter = acquireLock({ session, clock: systemClock });
    const elapsedMs = Date.now() - startedAt;

    expect(waiter.held).toBe(false);
    expect(waiter.respected).toEqual(held);
    expect(waiter.broken).toBeNull();
    expect(waiter.claim).toBeNull();
    // The wait is bounded by the product's one second, and it really is spent rather than skipped.
    // A synchronous sleep can return late, which is why the bound asserted is the window plus one
    // observation interval: an implementation that waits twice over, or not at all, fails here.
    expect(waiter.waited_ms).toBeLessThanOrEqual(DEFAULT_LOCK_WAIT_MS + LOCK_OBSERVATION_INTERVAL_MS);
    expect(elapsedMs).toBeGreaterThanOrEqual(DEFAULT_LOCK_WAIT_MS - 100);
    expect(elapsedMs).toBeLessThan(DEFAULT_LOCK_WAIT_MS + 2_000);
    expect(JSON.parse(readFileSync(session.lock, "utf8"))).toEqual(held);

    // A writer that cannot take the lock still does its job: a distinct snapshot of its own.
    const waiterWritten = writeSnapshot({ session, snapshot: makeSnapshot({ createdAt: utcInstantFrom(T0 + 1_000), text: "the waiter's decision" }) });
    holder.release();

    expect(waiterWritten.path).not.toBe(holderWritten.path);
    expect(waiterWritten.created).toBe(true);
    const listed = listSnapshots(session);
    expect(listed.quarantined).toEqual([]);
    expect(listed.snapshots).toHaveLength(2);
    expect(new Set(listed.snapshots.map((snapshot) => snapshot.envelope.hash)).size).toBe(2);
    for (const snapshot of listed.snapshots) expect(usableSnapshot(join(session.snapshots, snapshotFileName(snapshot.envelope)))).toEqual(snapshot);
    expect(readManifest(session, listed.entries).rebuilt).toBe(false);
    expect(storedLock(session)).toBeNull();
    expect(existsSync(session.lock)).toBe(false);
  });

  it("does not break an old record whose pid is still alive", () => {
    const session = newSession();
    const holder: ManifestLock = { pid: process.pid, host: hostname(), started_at: utcInstantFrom(T0) };
    leaveLock(session, holder);

    const lock = acquireLock({ session, clock: fixedClock(T0 + 31_000), waitMs: 100, sleep: () => {} });

    expect(lock.held).toBe(false);
    expect(lock.broken).toBeNull();
    expect(lock.respected).toEqual(holder);
    expect(JSON.parse(readFileSync(session.lock, "utf8"))).toEqual(holder);
  });

  it("proceeds without breaking a record left by a process that died inside its wait window", () => {
    const session = newSession();
    const holder: ManifestLock = { pid: deadPid(), host: hostname(), started_at: utcInstantFrom(T0) };
    leaveLock(session, holder);

    const lock = acquireLock({ session, clock: fixedClock(T0 + 1_000), waitMs: 0, sleep: () => {} });

    expect(lock.held).toBe(false);
    expect(lock.broken).toBeNull();
    expect(lock.respected).toEqual(holder);
    // A record that is young is respected on age alone; the write proceeds anyway, which is what
    // keeps a crash from blocking the store for the next thirty seconds.
    expect(JSON.parse(readFileSync(session.lock, "utf8"))).toEqual(holder);
    const written = writeSnapshot({ session, snapshot: makeSnapshot() });
    expect(usableSnapshot(written.path)).toBeDefined();
  });

  it("does not treat a record from another host as a dead pid it can verify", () => {
    const session = newSession();
    const holder: ManifestLock = { pid: deadPid(), host: "another-host", started_at: "2020-01-01T00:00:00Z" };
    leaveLock(session, holder);

    const lock = acquireLock({ session, clock: fixedClock(T0), waitMs: 0, sleep: () => {} });

    expect(lock.held).toBe(false);
    expect(lock.broken).toBeNull();
    expect(lock.respected).toEqual(holder);
  });
});

describe("lock recording", () => {
  it("clears the claim on release and leaves a repeated release with nothing to write", () => {
    const session = newSession();
    const lock = acquireLock({ session, clock: fixedClock(T0), sleep: () => {} });

    expect(storedLock(session)).toEqual({ pid: process.pid, host: hostname(), started_at: utcInstantFrom(T0) });
    expect(lock.release()).toEqual({ path: session.manifest, rebuilt: false, reason: null });

    expect(storedLock(session)).toBeNull();
    expect(existsSync(session.lock)).toBe(false);
    expect(lock.release()).toBeNull();
  });

  it("reports the index repair it had to persist while recording the claim", () => {
    const session = newSession();
    writeSnapshot({ session, snapshot: makeSnapshot() });
    rmSync(session.manifest);

    const lock = acquireLock({ session, clock: fixedClock(T0), sleep: () => {} });

    expect(lock.claim).toEqual({ path: session.manifest, rebuilt: true, reason: "missing" });
    expect(storedManifest(session).snapshots).toHaveLength(1);
  });

  it("leaves another writer's claim alone when a writer that never held the lock releases", () => {
    const session = newSession();
    // Distinct from this writer's own record in the way any other process's would be: it started
    // at a different instant, so dropping it would not be dropping this writer's own claim.
    const other: ManifestLock = { pid: process.pid, host: hostname(), started_at: utcInstantFrom(T0 - 5_000) };
    leaveLock(session, other);

    const lock = acquireLock({ session, clock: fixedClock(T0), waitMs: 0, sleep: () => {} });
    expect(lock.held).toBe(false);
    expect(lock.respected).toEqual(other);
    expect(lock.release()).toBeNull();

    expect(JSON.parse(readFileSync(session.lock, "utf8"))).toEqual(other);
  });

  it("takes the lock and writes a usable snapshot on a store that has never been written", () => {
    const session = newSession();
    const lock = acquireLock({ session, clock: fixedClock(T0), sleep: () => {} });

    expect(lock.held).toBe(true);
    const written = writeSnapshot({ session, snapshot: makeSnapshot() });

    expect(usableSnapshot(written.path)).toBeDefined();
    expect(listSnapshots(session).entries).toHaveLength(1);
  });
});