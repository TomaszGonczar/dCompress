import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixedClock } from "../src/core/clock.js";
import { readManifest, snapshotId } from "../src/store/manifest.js";
import { sessionPaths } from "../src/store/paths.js";
import { applyRetention } from "../src/store/retention.js";
import { listSnapshots, snapshotFileName, writeSnapshot } from "../src/store/snapshot.js";
import type { ManifestReadResult, ManifestSnapshotEntry, SessionPaths } from "../src/store/types.js";
import { utcInstantFrom } from "../src/store/types.js";
import { makeSnapshot, refusalFrom, tempRoots } from "./helpers/store.js";

const temp = tempRoots();
afterEach(temp.clean);

const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.parse("2026-09-13T08:41:09Z");

function newSession(sessionId = "session-1"): SessionPaths {
  return sessionPaths({ adapter: "claude", sessionId, root: temp.next() });
}

/** Write `count` snapshots a second apart, oldest first, and hand back their envelopes. */
function fill(session: SessionPaths, count: number, firstMs: number): ManifestSnapshotEntry[] {
  const written: ManifestSnapshotEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const snapshot = makeSnapshot({ createdAt: utcInstantFrom(firstMs + index * 1_000), text: `decision ${index}` });
    writeSnapshot({ session, snapshot });
    written.push({ id: snapshotId(snapshot.envelope.created_at, snapshot.envelope.hash), hash: snapshot.envelope.hash, created_at: snapshot.envelope.created_at, facts: 1, pinned: false, degraded: [] });
  }
  return written;
}

/** Read the index the way a caller must: list what exists, then compare the manifest to it. */
function readIndex(session: SessionPaths): ManifestReadResult {
  const listed = listSnapshots(session);
  return readManifest(session, listed.entries);
}

function pin(session: SessionPaths, hash: string): void {
  const value = JSON.parse(readFileSync(session.manifest, "utf8"));
  for (const entry of value.snapshots) if (entry.hash === hash) entry.pinned = true;
  writeFileSync(session.manifest, JSON.stringify(value, null, 2));
}

describe("retention boundaries", () => {
  it("retains fifteen snapshots and prunes exactly the oldest on the sixteenth", () => {
    const session = newSession();
    const written = fill(session, 16, T0);
    const nowMs = T0 + 60_000;

    const result = applyRetention({ session, clock: fixedClock(nowMs) });

    expect(result.pruned).toHaveLength(1);
    expect(result.pruned[0].hash).toBe(written[0].hash);
    expect(result.pruned[0].reason).toBe("retention:count");
    expect(result.pruned[0].id).toBe(written[0].id);
    expect(result.pruned[0].at).toBe(utcInstantFrom(nowMs));
    expect(result.pruned[0].path).toBe(join(session.snapshots, snapshotFileName(written[0])));
    expect(result.kept).toEqual(written.slice(1).map((entry) => entry.id));

    expect(existsSync(result.pruned[0].path)).toBe(false);
    expect(listSnapshots(session).snapshots).toHaveLength(15);
    // The prune is on the record, and the index still agrees with the files that remain.
    const index = readIndex(session);
    expect(index.rebuilt).toBe(false);
    expect(index.manifest.pruned).toEqual([{ hash: written[0].hash, reason: "retention:count", at: utcInstantFrom(nowMs) }]);
    expect(index.manifest.snapshots.map((entry) => entry.id)).toEqual(result.kept);
  });

  it("leaves a store of exactly fifteen snapshots untouched, inside the window", () => {
    const session = newSession();
    const written = fill(session, 15, T0);
    const manifestBefore = readFileSync(session.manifest, "utf8");

    const result = applyRetention({ session, clock: fixedClock(T0 + HOUR_MS) });

    expect(result.pruned).toEqual([]);
    expect(result.kept).toEqual(written.map((entry) => entry.id));
    expect(result.manifest).toBeNull();
    expect(readFileSync(session.manifest, "utf8")).toBe(manifestBefore);
    expect(readdirSync(session.snapshots)).toHaveLength(15);
  });

  it("retains a snapshot inside the seventy-two hours and prunes one past it, by age", () => {
    const session = newSession();
    const older = makeSnapshot({ createdAt: utcInstantFrom(T0 - 73 * HOUR_MS), text: "three days old" });
    const newer = makeSnapshot({ createdAt: utcInstantFrom(T0 - 71 * HOUR_MS), text: "under three days old" });
    writeSnapshot({ session, snapshot: older });
    writeSnapshot({ session, snapshot: newer });

    const result = applyRetention({ session, clock: fixedClock(T0) });

    expect(result.pruned.map((entry) => entry.hash)).toEqual([older.envelope.hash]);
    expect(result.pruned[0].reason).toBe("retention:age");
    expect(result.kept).toEqual([snapshotId(newer.envelope.created_at, newer.envelope.hash)]);
    expect(existsSync(join(session.snapshots, snapshotFileName(older.envelope)))).toBe(false);
    expect(existsSync(join(session.snapshots, snapshotFileName(newer.envelope)))).toBe(true);
  });

  it("prunes age before count when both rules select, and reports each reason", () => {
    const session = newSession();
    const written = fill(session, 16, T0 - 100 * HOUR_MS);

    const result = applyRetention({ session, clock: fixedClock(T0) });

    // Fifteen candidates are past the window; the newest is never one of them.
    expect(result.pruned).toHaveLength(15);
    expect(result.pruned.every((entry) => entry.reason === "retention:age")).toBe(true);
    expect(result.pruned.map((entry) => entry.hash)).toEqual(written.slice(0, 15).map((entry) => entry.hash));
    expect(result.kept).toEqual([written[15].id]);
    expect(existsSync(join(session.snapshots, snapshotFileName(written[15])))).toBe(true);
  });
});

describe("exemptions", () => {
  it("keeps the oldest snapshot when it is pinned, and prunes the next one instead", () => {
    const session = newSession();
    const written = fill(session, 16, T0);
    pin(session, written[0].hash);

    const result = applyRetention({ session, clock: fixedClock(T0 + 60_000) });

    expect(result.pruned.map((entry) => entry.hash)).toEqual([written[1].hash]);
    expect(result.pruned[0].reason).toBe("retention:count");
    expect(result.kept).toContain(written[0].id);
    expect(existsSync(join(session.snapshots, snapshotFileName(written[0])))).toBe(true);
    expect(existsSync(join(session.snapshots, snapshotFileName(written[1])))).toBe(false);
    // The pin survives the prune pass it did not take part in.
    expect(readIndex(session).manifest.snapshots[0].pinned).toBe(true);
  });

  it("retains a pinned snapshot that is older than the window", () => {
    const session = newSession();
    const pinned = makeSnapshot({ createdAt: utcInstantFrom(T0 - 100 * HOUR_MS), text: "pinned across the window" });
    const fresh = makeSnapshot({ createdAt: utcInstantFrom(T0), text: "fresh" });
    writeSnapshot({ session, snapshot: pinned });
    writeSnapshot({ session, snapshot: fresh });
    pin(session, pinned.envelope.hash);

    const result = applyRetention({ session, clock: fixedClock(T0) });

    expect(result.pruned).toEqual([]);
    expect(result.kept).toEqual([snapshotId(pinned.envelope.created_at, pinned.envelope.hash), snapshotId(fresh.envelope.created_at, fresh.envelope.hash)]);
    expect(existsSync(join(session.snapshots, snapshotFileName(pinned.envelope)))).toBe(true);
  });

  it("never prunes the newest snapshot when a backwards clock jump makes the store look ancient", () => {
    const session = newSession();
    const written = fill(session, 3, T0 - 100 * HOUR_MS);

    const result = applyRetention({ session, clock: fixedClock(T0) });

    expect(result.kept).toContain(written[2].id);
    expect(existsSync(join(session.snapshots, snapshotFileName(written[2])))).toBe(true);
  });

  it("never prunes the newest snapshot when the clock jumps backwards past the whole store", () => {
    const session = newSession();
    const written = fill(session, 20, T0);

    // The clock now reads an hour before the store was written, so every age is negative: only the
    // count rule can select anything, and the newest snapshot is still not a candidate for it.
    const result = applyRetention({ session, clock: fixedClock(T0 - HOUR_MS) });

    expect(result.pruned).toHaveLength(5);
    expect(result.pruned.every((entry) => entry.reason === "retention:count")).toBe(true);
    expect(result.kept).toHaveLength(15);
    expect(result.kept).toContain(written[19].id);
    expect(existsSync(join(session.snapshots, snapshotFileName(written[19])))).toBe(true);
  });
});

describe("dry run", () => {
  it("reports the same prune set it would delete and leaves every file and the index in place", () => {
    const session = newSession();
    const written = fill(session, 16, T0);
    const before = readdirSync(session.snapshots).sort();
    const manifestBefore = readFileSync(session.manifest, "utf8");
    const nowMs = T0 + 60_000;

    const dry = applyRetention({ session, clock: fixedClock(nowMs), dryRun: true });

    expect(dry.dryRun).toBe(true);
    expect(dry.manifest).toBeNull();
    expect(dry.pruned.map((entry) => entry.hash)).toEqual([written[0].hash]);
    expect(readdirSync(session.snapshots).sort()).toEqual(before);
    expect(readFileSync(session.manifest, "utf8")).toBe(manifestBefore);

    const real = applyRetention({ session, clock: fixedClock(nowMs) });

    expect(real.pruned).toEqual(dry.pruned);
    expect(real.kept).toEqual(dry.kept);
    expect(real.pruned.map((entry) => entry.reason)).toEqual(dry.pruned.map((entry) => entry.reason));
  });
});

describe("deletion failures", () => {
  it.skipIf(process.platform === "win32")("refuses when a selected snapshot cannot be deleted, and records nothing as pruned", () => {
    const session = newSession();
    fill(session, 16, T0);
    chmodSync(session.snapshots, 0o500);
    try {
      const refusal = refusalFrom(() => applyRetention({ session, clock: fixedClock(T0 + 60_000) }));

      expect(refusal.code).toBe("state-unreadable");
      expect(refusal.message).toContain("permission denied");
    } finally {
      chmodSync(session.snapshots, 0o700);
    }

    expect(readdirSync(session.snapshots)).toHaveLength(16);
    const index = readIndex(session);
    expect(index.rebuilt).toBe(false);
    expect(index.manifest.pruned).toEqual([]);
  });
});