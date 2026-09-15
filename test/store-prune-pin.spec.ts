import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CliIo } from "../src/cli.js";
import { run } from "../src/cli.js";
import { readManifest, snapshotId } from "../src/store/manifest.js";
import { sessionPaths } from "../src/store/paths.js";
import { listSnapshots, shortHash, snapshotFileName, writeSnapshot } from "../src/store/snapshot.js";
import type { ManifestSnapshotEntry, SessionPaths } from "../src/store/types.js";
import { utcInstantFrom } from "../src/store/types.js";
import { makeSnapshot, tempRoots } from "./helpers/store.js";

const temp = tempRoots();
afterEach(temp.clean);

const SECOND_MS = 1_000;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

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
 * Write `count` snapshots a second apart, ending one second before `nowMs`, and hand back their
 * manifest entries oldest first. Real time, not a fixed clock: every instant stays well inside
 * the seventy-two-hour window, so only the count rule can select anything.
 */
function fill(session: SessionPaths, count: number, nowMs: number): ManifestSnapshotEntry[] {
  const firstMs = nowMs - count * SECOND_MS;
  const written: ManifestSnapshotEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const snapshot = makeSnapshot({ createdAt: utcInstantFrom(firstMs + index * SECOND_MS), text: `decision ${index}` });
    writeSnapshot({ session, snapshot });
    written.push({
      id: snapshotId(snapshot.envelope.created_at, snapshot.envelope.hash),
      hash: snapshot.envelope.hash,
      created_at: snapshot.envelope.created_at,
      facts: 1,
      pinned: false,
      degraded: [],
    });
  }
  return written;
}

/** Read the index the way a caller must: list what exists, then compare the manifest to it. */
function readIndex(session: SessionPaths) {
  const entries = listSnapshots(session).entries;
  return { entries, read: readManifest(session, entries) };
}

function pin(sessionId: string, root: string, query: string, extra: readonly string[] = []): RecordedIo {
  const output = io();
  const status = run(["pin", "--session", sessionId, "--snapshot", query, "--store", root, ...extra], callIo(output));
  expect(status).toBe(0);
  return output;
}

describe("prune", () => {
  it("removes exactly the oldest snapshot on the sixteenth and leaves the index agreeing with the disk", () => {
    const root = temp.next();
    const session = newSession(root);
    const written = fill(session, 16, Date.now());
    const output = io();

    expect(run(["prune", "--session", "session-1", "--store", root], callIo(output))).toBe(0);

    const { entries, read } = readIndex(session);
    expect(entries.map((entry) => entry.id)).toEqual(written.slice(1).map((entry) => entry.id));
    expect(entries).toHaveLength(15);
    expect(existsSync(join(session.snapshots, snapshotFileName(written[0])))).toBe(false);
    expect(readdirSync(session.snapshots)).toHaveLength(15);
    // `rebuilt: false` is the claim that the stored manifest and the files on disk agree.
    expect(read.rebuilt).toBe(false);
    expect(read.manifest.snapshots.map((entry) => entry.id)).toEqual(written.slice(1).map((entry) => entry.id));
    expect(read.manifest.pruned).toEqual([{ hash: written[0].hash, reason: "retention:count", at: expect.stringMatching(UTC_INSTANT) }]);

    const text = output.stdout.join("");
    expect(text).toContain("pruned: 1");
    expect(text).toContain(`  ${shortHash(written[0].hash)}  ${written[0].created_at}  reason=retention:count`);
    expect(text).toContain("kept: 15");
    expect(text).toContain(written[15].id);
    expect(text).not.toContain(written[0].id);
  });

  it("reports the same set under --dry-run and leaves every byte in place", () => {
    const root = temp.next();
    const session = newSession(root);
    const written = fill(session, 16, Date.now());
    const manifestBefore = readFileSync(session.manifest, "utf8");
    const filesBefore = readdirSync(session.snapshots).sort();

    const dry = io();
    expect(run(["prune", "--session", "session-1", "--store", root, "--dry-run", "--json"], callIo(dry))).toBe(0);
    const planned = JSON.parse(dry.stdout.join(""));

    expect(readFileSync(session.manifest, "utf8")).toBe(manifestBefore);
    expect(readdirSync(session.snapshots).sort()).toEqual(filesBefore);
    expect(planned.dryRun).toBe(true);
    expect(planned.policy).toEqual({ maxSnapshots: 15, maxAgeMs: 72 * 60 * 60 * 1_000 });
    expect(planned.manifest).toBeNull();
    expect(planned.pruned).toHaveLength(1);
    expect(planned.pruned[0]).toMatchObject({
      id: written[0].id,
      hash: written[0].hash,
      short: shortHash(written[0].hash),
      created_at: written[0].created_at,
      reason: "retention:count",
      path: join(session.snapshots, snapshotFileName(written[0])),
    });
    expect(planned.pruned[0].at).toMatch(UTC_INSTANT);
    expect(planned.kept).toEqual(written.slice(1).map((entry) => entry.id));

    const applied = io();
    expect(run(["prune", "--session", "session-1", "--store", root, "--json"], callIo(applied))).toBe(0);
    const performed = JSON.parse(applied.stdout.join(""));

    // The pass instant is the one field that may differ between the two runs; the selection,
    // its reasons, and the files it names must not.
    expect(performed.pruned.map((entry: { readonly id: string }) => entry.id)).toEqual(planned.pruned.map((entry: { readonly id: string }) => entry.id));
    expect(performed.pruned.map((entry: { readonly reason: string }) => entry.reason)).toEqual(planned.pruned.map((entry: { readonly reason: string }) => entry.reason));
    expect(performed.pruned.map((entry: { readonly path: string }) => entry.path)).toEqual(planned.pruned.map((entry: { readonly path: string }) => entry.path));
    expect(performed.pruned[0].at).toMatch(UTC_INSTANT);
    expect(performed.kept).toEqual(planned.kept);
    expect(performed.pruned).toHaveLength(1);
    expect(performed.dryRun).toBe(false);
    // The deletions happen before the index is rewritten, so the pass's own read reports the
    // repair it then persisted; the stored manifest is consistent (asserted in the first test).
    expect(performed.manifest).toMatchObject({ rebuilt: true, reason: "inconsistent" });
  });

  it("retains a snapshot pinned through the CLI, and prunes the next-oldest instead", () => {
    const root = temp.next();
    const session = newSession(root);
    const written = fill(session, 16, Date.now());

    const first = pin("session-1", root, shortHash(written[0].hash));
    expect(first.stdout.join("")).toContain("pinned: yes");
    expect(first.stdout.join("")).toContain("changed: yes");

    // A second pin of the same snapshot changes nothing and still succeeds.
    const again = pin("session-1", root, shortHash(written[0].hash));
    expect(again.stdout.join("")).toContain("changed: no");
    expect(pin("session-1", root, shortHash(written[0].hash), ["--json"]).stdout.join("")).toContain('"changed":false');

    const output = io();
    expect(run(["prune", "--session", "session-1", "--store", root], callIo(output))).toBe(0);

    const { read } = readIndex(session);
    expect(read.manifest.snapshots.map((entry) => entry.id)).toEqual([written[0], ...written.slice(2)].map((entry) => entry.id));
    expect(read.manifest.pruned).toEqual([{ hash: written[1].hash, reason: "retention:count", at: expect.stringMatching(UTC_INSTANT) }]);
    expect(existsSync(join(session.snapshots, snapshotFileName(written[0])))).toBe(true);
    expect(existsSync(join(session.snapshots, snapshotFileName(written[1])))).toBe(false);
    // The pin outlives the pass it was exempt from.
    expect(read.manifest.snapshots[0].pinned).toBe(true);
  });

  it("selects a snapshot again once --unpin clears its flag", () => {
    const root = temp.next();
    const session = newSession(root);
    const written = fill(session, 16, Date.now());
    const query = shortHash(written[0].hash);

    pin("session-1", root, query);
    const unpinned = pin("session-1", root, query, ["--unpin", "--json"]);
    expect(JSON.parse(unpinned.stdout.join(""))).toMatchObject({ pinned: false, changed: true });

    // Unpinning an already-unpinned snapshot is a no-op that still exits `EXIT_OK`.
    const noop = pin("session-1", root, query, ["--unpin"]);
    expect(noop.stdout.join("")).toContain("changed: no");

    expect(run(["prune", "--session", "session-1", "--store", root], callIo(io()))).toBe(0);

    const { read } = readIndex(session);
    expect(read.manifest.pruned).toEqual([{ hash: written[0].hash, reason: "retention:count", at: expect.stringMatching(UTC_INSTANT) }]);
    expect(existsSync(join(session.snapshots, snapshotFileName(written[0])))).toBe(false);
  });

  it("succeeds with an empty prune set rather than treating it as a failure", () => {
    const root = temp.next();
    const session = newSession(root);
    fill(session, 15, Date.now());
    const manifestBefore = readFileSync(session.manifest, "utf8");
    const output = io();

    expect(run(["prune", "--session", "session-1", "--store", root], callIo(output))).toBe(0);

    expect(output.stdout.join("")).toContain("pruned: none");
    expect(output.stdout.join("")).toContain("not written (nothing changed)");
    expect(readFileSync(session.manifest, "utf8")).toBe(manifestBefore);
  });
});

describe("pin", () => {
  it("emits byte-identical JSON while the flag is unchanged", () => {
    const root = temp.next();
    const session = newSession(root);
    const written = fill(session, 2, Date.now());

    pin("session-1", root, shortHash(written[0].hash));
    const settled = pin("session-1", root, shortHash(written[0].hash), ["--json"]).stdout.join("");
    const repeated = pin("session-1", root, shortHash(written[0].hash), ["--json"]).stdout.join("");

    expect(repeated).toBe(settled);
    expect(JSON.parse(settled)).toMatchObject({
      session: session.name,
      store: session.root,
      pinned: true,
      changed: false,
      snapshot: { id: written[0].id, hash: written[0].hash, short: shortHash(written[0].hash), created_at: written[0].created_at },
      manifest: { rebuilt: false, reason: null },
    });
  });

  it("refuses an unknown snapshot id with an actionable message and writes nothing", () => {
    const root = temp.next();
    const session = newSession(root);
    fill(session, 2, Date.now());
    const manifestBefore = readFileSync(session.manifest, "utf8");
    const output = io();

    const status = run(["pin", "--session", "session-1", "--snapshot", "deadbeefcafe", "--store", root], callIo(output));

    expect(status).toBe(1);
    expect(output.stderr.join("")).toContain('No snapshot "deadbeefcafe"');
    expect(output.stderr.join("")).toContain("dcompress list --session session-1");
    expect(readFileSync(session.manifest, "utf8")).toBe(manifestBefore);
  });
});

describe("a missing required argument is refused", () => {
  it.each([["prune"], ["pin"]])("%s without --session", (command) => {
    const root = temp.next();
    const output = io();
    const argv = command === "pin" ? [command, "--snapshot", "deadbeefcafe", "--store", root] : [command, "--store", root];

    const status = run(argv, callIo(output));

    expect(status).toBe(2);
    expect(output.stderr.join("")).toContain("requires an explicit --session <id>");
  });

  it("pin without --snapshot", () => {
    const output = io();

    const status = run(["pin", "--session", "session-1", "--store", temp.next()], callIo(output));

    expect(status).toBe(2);
    expect(output.stderr.join("")).toContain("pin requires an explicit --snapshot <id>.");
  });
});