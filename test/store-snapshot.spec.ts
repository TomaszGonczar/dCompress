import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readManifest } from "../src/store/manifest.js";
import { ensureSessionDirectories, sessionPaths } from "../src/store/paths.js";
import { listSnapshots, readSnapshot, snapshotFileName, writeSnapshot } from "../src/store/snapshot.js";
import type { SessionPaths } from "../src/store/types.js";
import { makeSnapshot, quarantinedSnapshot, refusalFrom, tempRoots, usableSnapshot } from "./helpers/store.js";

const temp = tempRoots();
afterEach(temp.clean);

/** A fresh disposable store root per session, so no test can see another's files. */
function newSession(sessionId = "session-1"): SessionPaths {
  return sessionPaths({ adapter: "claude", sessionId, root: temp.next() });
}

function tamperWith(path: string, edit: (parsed: { payload: { facts: Array<{ snippet: string; attrs: Record<string, unknown> }> } }) => void): void {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  edit(parsed);
  writeFileSync(path, JSON.stringify(parsed, null, 2));
}

describe("snapshot write and read", () => {
  it("round-trips a snapshot through the store under the name the envelope derives", () => {
    const session = newSession();
    const snapshot = makeSnapshot();

    const written = writeSnapshot({ session, snapshot });

    expect(written.created).toBe(true);
    expect(basename(written.path)).toBe(`${snapshot.envelope.created_at}-${snapshot.envelope.hash.slice(7, 19)}.json`);
    expect(usableSnapshot(written.path)).toEqual(snapshot);
  });

  it("returns the stored snapshot unchanged, envelope included", () => {
    const session = newSession();
    const snapshot = makeSnapshot({ degraded: ["budget-exceeded", "schema-drift"] });
    const written = writeSnapshot({ session, snapshot });

    const result = readSnapshot(written.path);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected a usable snapshot");
    expect(result.verified).toBe(true);
    expect(result.snapshot.envelope.degraded).toEqual(["budget-exceeded", "schema-drift"]);
  });

  it("treats a repeated write of the same snapshot as already stored", () => {
    const session = newSession();
    const snapshot = makeSnapshot();

    const first = writeSnapshot({ session, snapshot });
    const second = writeSnapshot({ session, snapshot });

    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    const listed = listSnapshots(session);
    expect(listed.entries).toHaveLength(1);
    expect(listed.snapshots).toHaveLength(1);
  });
});

describe("quarantine", () => {
  it("quarantines a snapshot whose payload bytes were tampered with, and never returns it as usable", () => {
    const session = newSession();
    const { path } = writeSnapshot({ session, snapshot: makeSnapshot() });
    tamperWith(path, (parsed) => {
      parsed.payload.facts[0].snippet = "tampered";
    });

    const result = quarantinedSnapshot(path);

    expect(result.code).toBe("hash-mismatch");
    expect(result.quarantinePath).toBe(`${path}.corrupt`);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(result.quarantinePath, "utf8")).toContain("tampered");
    expect(listSnapshots(session).snapshots).toEqual([]);
  });

  it("quarantines a truncated snapshot file instead of throwing a parse error", () => {
    const session = newSession();
    const { path } = writeSnapshot({ session, snapshot: makeSnapshot() });
    const bytes = readFileSync(path, "utf8");
    writeFileSync(path, bytes.slice(0, Math.floor(bytes.length / 2)));

    const result = quarantinedSnapshot(path);

    expect(result.code).toBe("unparseable");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(session.snapshots)).toEqual([`${basename(path)}.corrupt`]);
    expect(listSnapshots(session).snapshots).toEqual([]);
  });

  it("quarantines a JSON file whose shape is not a snapshot", () => {
    const session = newSession();
    ensureSessionDirectories(session);
    const path = join(session.snapshots, "2026-09-13T08:41:09Z-0123456789ab.json");
    writeFileSync(path, JSON.stringify({ envelope: { hash: "sha256:not-a-hash" }, payload: {} }));

    expect(quarantinedSnapshot(path).code).toBe("invalid-shape");
  });

  it("quarantines a payload that cannot be canonicalized", () => {
    const session = newSession();
    const { path } = writeSnapshot({ session, snapshot: makeSnapshot() });
    tamperWith(path, (parsed) => {
      parsed.payload.facts[0].attrs = { cue: 1.5 };
    });

    expect(quarantinedSnapshot(path).code).toBe("payload-invalid");
  });

  it("quarantines a snapshot that belongs to another session rather than mixing sessions", () => {
    const session = newSession();
    ensureSessionDirectories(session);
    const foreign = makeSnapshot({ sessionId: "session-2" });
    const path = join(session.snapshots, snapshotFileName(foreign.envelope));
    writeFileSync(path, JSON.stringify(foreign, null, 2));

    const listed = listSnapshots(session);

    expect(listed.snapshots).toEqual([]);
    expect(listed.quarantined.map((entry) => entry.code)).toEqual(["session-mismatch"]);
    expect(existsSync(path)).toBe(false);
  });

  it("reads a hash-mismatched file only when the caller explicitly asks for a repair path", () => {
    const session = newSession();
    const { path } = writeSnapshot({ session, snapshot: makeSnapshot() });
    tamperWith(path, (parsed) => {
      parsed.payload.facts[0].snippet = "edited";
    });

    const repaired = readSnapshot(path, { verify: false });

    expect(repaired.status).toBe("ok");
    if (repaired.status !== "ok") throw new Error("expected the repair path to read the file");
    expect(repaired.verified).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("keeps an earlier quarantine instead of overwriting it", () => {
    const session = newSession();
    const { path } = writeSnapshot({ session, snapshot: makeSnapshot() });
    writeFileSync(`${path}.corrupt`, "earlier evidence");
    writeFileSync(path, "{ truncated");

    const result = quarantinedSnapshot(path);

    expect(result.quarantinePath).toBe(`${path}.corrupt.1`);
    expect(readFileSync(`${path}.corrupt`, "utf8")).toBe("earlier evidence");
  });

  it("refuses to quarantine when every name beside the file is taken", () => {
    const session = newSession();
    const { path } = writeSnapshot({ session, snapshot: makeSnapshot() });
    writeFileSync(`${path}.corrupt`, "taken");
    for (let index = 1; index < 1000; index += 1) writeFileSync(`${path}.corrupt.${index}`, "taken");
    writeFileSync(path, "{ truncated");

    expect(refusalFrom(() => readSnapshot(path)).code).toBe("quarantine-unavailable");
  });

  it("refuses to read a snapshot that does not exist", () => {
    const session = newSession();
    ensureSessionDirectories(session);

    expect(refusalFrom(() => readSnapshot(join(session.snapshots, "2026-09-13T08:41:09Z-0123456789ab.json"))).code).toBe("snapshot-unreadable");
  });
});

describe("atomic write", () => {
  it("leaves no partial file under the final name and ignores a leftover temp file", () => {
    const session = newSession();
    const snapshot = makeSnapshot();
    const { path } = writeSnapshot({ session, snapshot });
    const litter = `${join(session.snapshots, snapshotFileName(snapshot.envelope))}.tmp-999999`;
    writeFileSync(litter, "{\"envelope\":");

    const listed = listSnapshots(session);

    expect(listed.snapshots.map((entry) => entry.envelope.hash)).toEqual([snapshot.envelope.hash]);
    expect(listed.quarantined).toEqual([]);
    expect(readManifest(session, listed.entries).rebuilt).toBe(false);
    expect(existsSync(litter)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("refuses to overwrite a different snapshot that occupies the derived name", () => {
    const session = newSession();
    const first = makeSnapshot({ text: "first decision" });
    const second = makeSnapshot({ text: "second decision" });
    const { path } = writeSnapshot({ session, snapshot: first });
    const collision = join(session.snapshots, snapshotFileName(second.envelope));
    writeFileSync(collision, readFileSync(path, "utf8"));

    const refusal = refusalFrom(() => writeSnapshot({ session, snapshot: second }));

    expect(refusal.code).toBe("snapshot-name-collision");
    expect(usableSnapshot(collision).envelope.hash).toBe(first.envelope.hash);
  });

  it("refuses to write through a symlinked snapshot path", () => {
    const session = newSession();
    ensureSessionDirectories(session);
    const snapshot = makeSnapshot();
    const path = join(session.snapshots, snapshotFileName(snapshot.envelope));
    const target = join(session.root, "outside.json");
    writeFileSync(target, "{}");
    symlinkSync(target, path);

    expect(refusalFrom(() => writeSnapshot({ session, snapshot })).code).toBe("symlink-state");
    expect(readFileSync(target, "utf8")).toBe("{}");
  });
});

describe("write refusals", () => {
  it("refuses a snapshot whose envelope hash is not its payload hash", () => {
    const session = newSession();
    const snapshot = makeSnapshot();
    const broken = { ...snapshot, envelope: { ...snapshot.envelope, hash: `sha256:${"a".repeat(64)}` } };

    expect(refusalFrom(() => writeSnapshot({ session, snapshot: broken })).code).toBe("snapshot-hash-mismatch");
    expect(existsSync(session.manifest)).toBe(false);
  });

  it("refuses a creation instant that is not the seconds-precision UTC form the name derives from", () => {
    const session = newSession();
    const snapshot = makeSnapshot({ createdAt: "2026-09-13T08:41:09.123Z" });

    const refusal = refusalFrom(() => writeSnapshot({ session, snapshot }));

    expect(refusal.code).toBe("invalid-snapshot");
    expect(refusal.message).toContain("created_at");
  });

  it("refuses a snapshot with an unknown payload field", () => {
    const session = newSession();
    const snapshot = makeSnapshot();
    const broken = { ...snapshot, payload: { ...snapshot.payload, injected: 1 } };

    expect(refusalFrom(() => writeSnapshot({ session, snapshot: broken })).code).toBe("invalid-snapshot");
  });

  it("refuses a payload the canonicalizer rejects, before it can reach the store", () => {
    const session = newSession();
    const snapshot = makeSnapshot();
    // A float is outside the payload's integer-only number rule (SCHEMA §5.1); the envelope
    // still carries the hash of the untampered payload.
    const broken = { ...snapshot, payload: { ...snapshot.payload, facts: [{ ...snapshot.payload.facts[0], attrs: { cue: 1.5 } }] } };

    const refusal = refusalFrom(() => writeSnapshot({ session, snapshot: broken }));

    expect(refusal.code).toBe("invalid-snapshot");
    expect(refusal.message).toContain("canonicalized");
  });
});

describe("private file modes", () => {
  it.skipIf(process.platform === "win32")("creates 0700 directories and 0600 files", () => {
    const session = newSession();
    const { path } = writeSnapshot({ session, snapshot: makeSnapshot() });
    const mode = (target: string): number => statSync(target).mode & 0o777;

    expect(mode(session.root)).toBe(0o700);
    expect(mode(session.sessions)).toBe(0o700);
    expect(mode(session.session)).toBe(0o700);
    expect(mode(session.snapshots)).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    expect(mode(session.manifest)).toBe(0o600);
  });
});