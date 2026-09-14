import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MANIFEST_VERSION, readManifest, writeManifest } from "../src/store/manifest.js";
import { sessionPaths } from "../src/store/paths.js";
import { listSnapshots, snapshotFileName, writeSnapshot } from "../src/store/snapshot.js";
import type { Manifest, SessionPaths } from "../src/store/types.js";
import { makeSnapshot, tempRoots } from "./helpers/store.js";

const temp = tempRoots();
afterEach(temp.clean);

function newSession(sessionId = "session-1"): SessionPaths {
  return sessionPaths({ adapter: "claude", sessionId, root: temp.next() });
}

/** Read the session index the way a caller must: list what exists, then compare the manifest to it. */
function readIndex(session: SessionPaths): { readonly manifest: Manifest; readonly rebuilt: boolean; readonly reason: string | null; readonly quarantined: number } {
  const listed = listSnapshots(session);
  const read = readManifest(session, listed.entries);
  return { manifest: read.manifest, rebuilt: read.rebuilt, reason: read.reason, quarantined: listed.quarantined.length };
}

function storedManifest(session: SessionPaths): { snapshots: Manifest["snapshots"]; pruned: unknown; lock: unknown } & Record<string, unknown> {
  return JSON.parse(readFileSync(session.manifest, "utf8"));
}

function rewriteManifest(session: SessionPaths, edit: (value: Record<string, unknown>) => void): void {
  const value = storedManifest(session);
  edit(value);
  writeFileSync(session.manifest, JSON.stringify(value, null, 2));
}

const at = (second: number): string => `2026-09-13T08:41:${String(second).padStart(2, "0")}Z`;

describe("manifest index", () => {
  it("writes exactly the SCHEMA §8 shape and appends each snapshot on write", () => {
    const session = newSession();
    const first = makeSnapshot({ createdAt: at(9), text: "first decision" });
    const second = makeSnapshot({ createdAt: at(10), text: "second decision" });

    const writtenFirst = writeSnapshot({ session, snapshot: first });
    const writtenSecond = writeSnapshot({ session, snapshot: second });

    expect(writtenFirst.manifest.rebuilt).toBe(false);
    expect(writtenFirst.manifest.reason).toBeNull();
    expect(writtenSecond.manifest.rebuilt).toBe(false);

    const stored = storedManifest(session);
    expect(Object.keys(stored).sort()).toEqual(["lock", "manifest_version", "pruned", "session", "snapshots"]);
    expect(stored.manifest_version).toBe(MANIFEST_VERSION);
    expect(stored.session).toBe("claude-session-1");
    expect(stored.pruned).toEqual([]);
    expect(stored.lock).toBeNull();
    expect(stored.snapshots).toHaveLength(2);
    expect(Object.keys(stored.snapshots[0]).sort()).toEqual(["created_at", "degraded", "facts", "hash", "id", "pinned"]);
    expect(stored.snapshots[0].id).toBe(`${first.envelope.created_at}|${first.envelope.hash}`);
    expect(stored.snapshots[0].facts).toBe(1);
    expect(stored.snapshots[0].pinned).toBe(false);
    expect(stored.snapshots[1].hash).toBe(second.envelope.hash);
  });

  it("orders the index oldest first", () => {
    const session = newSession();
    for (const second of [11, 9, 10]) writeSnapshot({ session, snapshot: makeSnapshot({ createdAt: at(second), text: `at ${second}` }) });

    expect(readIndex(session).manifest.snapshots.map((entry) => entry.created_at)).toEqual([at(9), at(10), at(11)]);
  });

  it("reports no rebuild when the index already matches the directory, and does not rewrite it", () => {
    const session = newSession();
    writeSnapshot({ session, snapshot: makeSnapshot() });
    const before = readFileSync(session.manifest, "utf8");

    const read = readIndex(session);

    expect(read.rebuilt).toBe(false);
    expect(read.reason).toBeNull();
    expect(read.manifest.snapshots).toHaveLength(1);
    expect(readFileSync(session.manifest, "utf8")).toBe(before);
  });

  it("rebuilds from the directory when the manifest is missing, and reports it", () => {
    const session = newSession();
    writeSnapshot({ session, snapshot: makeSnapshot({ createdAt: at(9), text: "first" }) });
    writeSnapshot({ session, snapshot: makeSnapshot({ createdAt: at(10), text: "second" }) });
    rmSync(session.manifest);

    const read = readIndex(session);

    expect(read.rebuilt).toBe(true);
    expect(read.reason).toBe("missing");
    expect(read.manifest.session).toBe("claude-session-1");
    expect(read.manifest.snapshots.map((entry) => entry.created_at)).toEqual([at(9), at(10)]);
    expect(read.manifest.snapshots.every((entry) => entry.facts === 1)).toBe(true);
    // A read repairs nothing on disk; the next write persists the rebuilt index.
    expect(existsSync(session.manifest)).toBe(false);
    const next = writeSnapshot({ session, snapshot: makeSnapshot({ createdAt: at(11), text: "third" }) });
    expect(next.manifest.rebuilt).toBe(true);
    expect(next.manifest.reason).toBe("missing");
    expect(storedManifest(session).snapshots).toHaveLength(3);
  });

  it("rebuilds when the manifest is unparseable, and reports it", () => {
    const session = newSession();
    writeSnapshot({ session, snapshot: makeSnapshot({ createdAt: at(9) }) });
    writeSnapshot({ session, snapshot: makeSnapshot({ createdAt: at(10), text: "second" }) });
    writeFileSync(session.manifest, "{ this is not JSON");

    const read = readIndex(session);

    expect(read.rebuilt).toBe(true);
    expect(read.reason).toBe("unparseable");
    expect(read.manifest.snapshots).toHaveLength(2);
  });

  it.each([
    ["a snapshot file that the manifest does not list", (session: SessionPaths, value: Record<string, unknown>): void => {
      const unlisted = makeSnapshot({ createdAt: at(12), text: "unlisted" });
      writeFileSync(join(session.snapshots, snapshotFileName(unlisted.envelope)), JSON.stringify(unlisted, null, 2));
      void value;
    }, 2],
    ["an entry for a snapshot that no longer exists", (_session: SessionPaths, value: Record<string, unknown>): void => {
      const phantom = { id: `${at(20)}|sha256:${"b".repeat(64)}`, hash: `sha256:${"b".repeat(64)}`, created_at: at(20), facts: 4, pinned: false, degraded: [] };
      value.snapshots = [...(value.snapshots as unknown[]), phantom];
    }, 1],
    ["a session that is not this store's session", (_session: SessionPaths, value: Record<string, unknown>): void => {
      value.session = "claude-someone-else";
    }, 1],
  ])("rebuilds when the manifest disagrees with the directory: %s", (_case, mutate, expected) => {
    const session = newSession();
    writeSnapshot({ session, snapshot: makeSnapshot({ createdAt: at(9) }) });
    rewriteManifest(session, (value) => mutate(session, value));

    const read = readIndex(session);

    // The directory is the truth: the rebuild lists what exists, not what the file claimed.
    expect(read.rebuilt).toBe(true);
    expect(read.reason).toBe("inconsistent");
    expect(read.manifest.snapshots).toHaveLength(expected);
    expect(read.manifest.snapshots.some((entry) => entry.hash === `sha256:${"b".repeat(64)}`)).toBe(false);
  });

  it("rebuilds a manifest written by a newer version instead of trusting its fields", () => {
    const session = newSession();
    writeSnapshot({ session, snapshot: makeSnapshot() });
    rewriteManifest(session, (value) => {
      value.manifest_version = MANIFEST_VERSION + 1;
    });

    const read = readIndex(session);

    expect(read.rebuilt).toBe(true);
    expect(read.reason).toBe("inconsistent");
    expect(read.manifest.snapshots).toHaveLength(1);
  });

  it("carries pins, prune history, and a live lock through a rebuild", () => {
    const session = newSession();
    const snapshot = makeSnapshot();
    writeSnapshot({ session, snapshot });
    const pruned = [{ hash: `sha256:${"c".repeat(64)}`, reason: "retention:count", at: at(20) }];
    const lock = { pid: 1234, host: "test-host", started_at: at(20) };
    rewriteManifest(session, (value) => {
      const entries: Array<Record<string, unknown>> = (value.snapshots as Array<Record<string, unknown>>).map((entry) => ({ ...entry, pinned: true }));
      entries.push({ id: `${at(21)}|sha256:${"d".repeat(64)}`, hash: `sha256:${"d".repeat(64)}`, created_at: at(21), facts: 2, pinned: false, degraded: [] });
      value.snapshots = entries;
      value.pruned = pruned;
      value.lock = lock;
    });

    const read = readIndex(session);

    expect(read.reason).toBe("inconsistent");
    expect(read.manifest.snapshots).toHaveLength(1);
    expect(read.manifest.snapshots[0].hash).toBe(snapshot.envelope.hash);
    expect(read.manifest.snapshots[0].pinned).toBe(true);
    expect(read.manifest.pruned).toEqual(pruned);
    expect(read.manifest.lock).toEqual(lock);
  });

  it("reports the degraded states of a snapshot in its index entry", () => {
    const session = newSession();
    writeSnapshot({ session, snapshot: makeSnapshot({ degraded: ["schema-drift", "internal-error"] }) });

    expect(readIndex(session).manifest.snapshots[0].degraded).toEqual(["schema-drift", "internal-error"]);
  });

  it("keeps a quarantined snapshot out of the rebuilt index", () => {
    const session = newSession();
    const kept = makeSnapshot({ createdAt: at(9), text: "kept" });
    const broken = makeSnapshot({ createdAt: at(10), text: "broken" });
    writeSnapshot({ session, snapshot: kept });
    const { path } = writeSnapshot({ session, snapshot: broken });
    writeFileSync(path, "{ truncated");

    const read = readIndex(session);

    expect(read.quarantined).toBe(1);
    expect(read.manifest.snapshots.map((entry) => entry.hash)).toEqual([kept.envelope.hash]);
  });

  it.each([
    ["an unknown field", (value: Record<string, unknown>): void => {
      value.extra = 1;
    }],
    ["a snapshot entry with an unknown field", (value: Record<string, unknown>): void => {
      (value.snapshots as Array<Record<string, unknown>>)[0].extra = true;
    }],
    ["an unknown degraded token", (value: Record<string, unknown>): void => {
      (value.snapshots as Array<Record<string, unknown>>)[0].degraded = ["not-a-state"];
    }],
    ["a prune reason outside the documented set", (value: Record<string, unknown>): void => {
      value.pruned = [{ hash: `sha256:${"c".repeat(64)}`, reason: "because", at: at(20) }];
    }],
    ["a lock that is not the documented shape", (value: Record<string, unknown>): void => {
      value.lock = { pid: 1 };
    }],
  ])("rebuilds an index it cannot trust: %s", (_case, mutate) => {
    const session = newSession();
    writeSnapshot({ session, snapshot: makeSnapshot() });
    rewriteManifest(session, mutate);

    const read = readIndex(session);

    expect(read.rebuilt).toBe(true);
    expect(read.reason).toBe("unparseable");
    expect(read.manifest.snapshots).toHaveLength(1);
  });

  it("refuses to write an index for a different session", () => {
    const session = newSession();
    const read = readIndex(session);

    expect(() => writeManifest(session, { ...read.manifest, session: "claude-someone-else" })).toThrowError(/belongs to/);
    expect(existsSync(session.manifest)).toBe(false);
  });
});