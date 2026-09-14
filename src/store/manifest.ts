/**
 * `manifest.json` — the ordered snapshot index and retention metadata (SCHEMA §8).
 *
 * The manifest is derived data. It is never hashed, never influences payload bytes, and is
 * rebuilt from the snapshot directory whenever it is missing, unparseable, or disagrees with
 * the files on disk (CONCEPT §11.6). A rebuild is reported to the caller rather than performed
 * silently, because losing a pin or a prune record is something a user has to be able to see.
 *
 * Reading is a pure read: this module never rewrites the file on a read path. The next write
 * persists the repaired index.
 */

import { readFileSync } from "node:fs";

import type { Snapshot } from "../core/types.js";
import { errnoCode, refuseSymlinkedPath, stateRefusal, writeFileAtomic } from "./fs.js";
import { ensureSessionDirectories } from "./paths.js";
import { StoreRefusal, compareText, isDegradedList, isHash, isInteger, isRecord, isUtcInstant } from "./types.js";
import type { Manifest, ManifestLock, ManifestPrunedEntry, ManifestReadResult, ManifestSnapshotEntry, PruneReason, SessionPaths } from "./types.js";

export const MANIFEST_VERSION = 1;

const MANIFEST_FIELDS: Record<string, true> = { lock: true, manifest_version: true, pruned: true, session: true, snapshots: true };
const SNAPSHOT_ENTRY_FIELDS: Record<string, true> = { created_at: true, degraded: true, facts: true, hash: true, id: true, pinned: true };
const PRUNED_ENTRY_FIELDS: Record<string, true> = { at: true, hash: true, reason: true };
const LOCK_FIELDS: Record<string, true> = { host: true, pid: true, started_at: true };
const PRUNE_REASONS: Record<PruneReason, true> = { "retention:count": true, "retention:age": true, manual: true, corrupt: true };

function hasExactFields(value: Record<string, unknown>, fields: Record<string, true>): boolean {
  const keys = Object.keys(value);
  return keys.length === Object.keys(fields).length && keys.every((key) => fields[key] === true);
}

/** Manifest order is oldest first, by `(created_at, id)`; retention reads the newest entry last. */
function sortEntries(entries: readonly ManifestSnapshotEntry[]): ManifestSnapshotEntry[] {
  return [...entries].sort((left, right) => compareText(left.created_at, right.created_at) || compareText(left.id, right.id));
}

export function snapshotId(createdAt: string, hash: string): string {
  return `${createdAt}|${hash}`;
}

export function manifestEntryFromSnapshot(snapshot: Snapshot): ManifestSnapshotEntry {
  const { envelope, payload } = snapshot;
  return {
    id: snapshotId(envelope.created_at, envelope.hash),
    hash: envelope.hash,
    created_at: envelope.created_at,
    facts: payload.counters.facts,
    pinned: false,
    degraded: [...envelope.degraded],
  };
}

type ParsedManifest =
  | { readonly status: "ok"; readonly manifest: Manifest }
  | { readonly status: "foreign" }
  | { readonly status: "invalid"; readonly reason: string };

function parseSnapshotEntry(value: unknown, index: number): ManifestSnapshotEntry | string {
  if (!isRecord(value)) return `snapshots[${index}] is not an object`;
  if (!hasExactFields(value, SNAPSHOT_ENTRY_FIELDS)) return `snapshots[${index}] has an unknown or missing field`;
  if (typeof value.id !== "string" || value.id.length === 0) return `snapshots[${index}].id is not a non-empty string`;
  if (!isHash(value.hash)) return `snapshots[${index}].hash is not sha256:<64 lowercase hex characters>`;
  if (!isUtcInstant(value.created_at)) return `snapshots[${index}].created_at is not a UTC instant at seconds precision`;
  if (!isInteger(value.facts)) return `snapshots[${index}].facts is not a non-negative integer`;
  if (typeof value.pinned !== "boolean") return `snapshots[${index}].pinned is not a boolean`;
  if (!isDegradedList(value.degraded)) return `snapshots[${index}].degraded contains an unknown state token`;
  return { id: value.id, hash: value.hash, created_at: value.created_at, facts: value.facts, pinned: value.pinned, degraded: value.degraded };
}

function parsePrunedEntry(value: unknown, index: number): ManifestPrunedEntry | string {
  if (!isRecord(value)) return `pruned[${index}] is not an object`;
  if (!hasExactFields(value, PRUNED_ENTRY_FIELDS)) return `pruned[${index}] has an unknown or missing field`;
  if (!isHash(value.hash)) return `pruned[${index}].hash is not sha256:<64 lowercase hex characters>`;
  if (typeof value.reason !== "string" || PRUNE_REASONS[value.reason as PruneReason] !== true) return `pruned[${index}].reason is not a known prune reason`;
  if (!isUtcInstant(value.at)) return `pruned[${index}].at is not a UTC instant at seconds precision`;
  return { hash: value.hash, reason: value.reason as PruneReason, at: value.at };
}

function parseLock(value: unknown): ManifestLock | null | string {
  if (value === null) return null;
  if (!isRecord(value)) return "lock is neither null nor an object";
  if (!hasExactFields(value, LOCK_FIELDS)) return "lock has an unknown or missing field";
  if (!isInteger(value.pid, 1)) return "lock.pid is not a positive integer";
  if (typeof value.host !== "string" || value.host.length === 0) return "lock.host is not a non-empty string";
  if (!isUtcInstant(value.started_at)) return "lock.started_at is not a UTC instant at seconds precision";
  return { pid: value.pid, host: value.host, started_at: value.started_at };
}

function parseManifest(raw: string): ParsedManifest {
  const invalid = (reason: string): ParsedManifest => ({ status: "invalid", reason });
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return invalid(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isRecord(value)) return invalid("the manifest is not an object");
  if (!hasExactFields(value, MANIFEST_FIELDS)) return invalid("the manifest has an unknown or missing field");
  if (!isInteger(value.manifest_version, 1)) return invalid("manifest_version is not a positive integer");
  // A manifest written by a future version is well-formed but is not this version's index:
  // rebuild it rather than trusting fields whose meaning may have changed.
  if (value.manifest_version !== MANIFEST_VERSION) return { status: "foreign" };
  if (typeof value.session !== "string" || value.session.length === 0) return invalid("session is not a non-empty string");
  if (!Array.isArray(value.snapshots)) return invalid("snapshots is not an array");
  if (!Array.isArray(value.pruned)) return invalid("pruned is not an array");

  const snapshots: ManifestSnapshotEntry[] = [];
  for (const [index, entry] of value.snapshots.entries()) {
    const parsed = parseSnapshotEntry(entry, index);
    if (typeof parsed === "string") return invalid(parsed);
    snapshots.push(parsed);
  }
  const pruned: ManifestPrunedEntry[] = [];
  for (const [index, entry] of value.pruned.entries()) {
    const parsed = parsePrunedEntry(entry, index);
    if (typeof parsed === "string") return invalid(parsed);
    pruned.push(parsed);
  }
  const lock = parseLock(value.lock);
  if (typeof lock === "string") return invalid(lock);

  return { status: "ok", manifest: { manifest_version: MANIFEST_VERSION, session: value.session, snapshots, pruned, lock } };
}

/** The index the files on disk imply, with pins carried over from a manifest that parsed. */
function rebuiltManifest(session: SessionPaths, entries: readonly ManifestSnapshotEntry[], previous: Manifest | null): Manifest {
  const pinned = new Map<string, boolean>();
  if (previous !== null) for (const entry of previous.snapshots) if (entry.pinned) pinned.set(entry.hash, true);
  return {
    manifest_version: MANIFEST_VERSION,
    session: session.name,
    snapshots: entries.map((entry) => ({ ...entry, pinned: pinned.get(entry.hash) === true })),
    // Prune history and a live lock exist only in the file, so a rebuild cannot derive them.
    pruned: previous?.pruned ?? [],
    lock: previous?.lock ?? null,
  };
}

function sameSnapshotIndex(stored: readonly ManifestSnapshotEntry[], onDisk: readonly ManifestSnapshotEntry[]): boolean {
  if (stored.length !== onDisk.length) return false;
  return stored.every((entry, index) => {
    const other = onDisk[index];
    return entry.id === other.id
      && entry.hash === other.hash
      && entry.created_at === other.created_at
      && entry.facts === other.facts
      && entry.degraded.join(",") === other.degraded.join(",");
  });
}

/**
 * Read the manifest for a session, comparing it against `entries` — the listing produced by
 * `listSnapshots`, which is the only source of truth for what exists.
 *
 * A repair is reported, never silent: `rebuilt` says the stored file was missing, unparseable,
 * or behind the directory. Nothing is written here.
 */
export function readManifest(session: SessionPaths, entries: readonly ManifestSnapshotEntry[]): ManifestReadResult {
  const onDisk = sortEntries(entries);
  refuseSymlinkedPath(session.manifest, "manifest file");
  let raw: string | null = null;
  try {
    raw = readFileSync(session.manifest, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") raw = null;
    else throw stateRefusal(error, session.manifest, "manifest file", "file") ?? error;
  }
  if (raw === null) {
    // An absent index for a session that has no snapshots is ordinary first use, not a repair:
    // there is no directory listing it failed to describe.
    return { path: session.manifest, manifest: rebuiltManifest(session, onDisk, null), rebuilt: onDisk.length > 0, reason: onDisk.length > 0 ? "missing" : null };
  }

  const parsed = parseManifest(raw);
  if (parsed.status === "invalid") {
    return { path: session.manifest, manifest: rebuiltManifest(session, onDisk, null), rebuilt: true, reason: "unparseable" };
  }
  if (parsed.status === "foreign") {
    return { path: session.manifest, manifest: rebuiltManifest(session, onDisk, null), rebuilt: true, reason: "inconsistent" };
  }
  if (parsed.manifest.session !== session.name || !sameSnapshotIndex(parsed.manifest.snapshots, onDisk)) {
    return { path: session.manifest, manifest: rebuiltManifest(session, onDisk, parsed.manifest), rebuilt: true, reason: "inconsistent" };
  }
  return { path: session.manifest, manifest: parsed.manifest, rebuilt: false, reason: null };
}

/** Add a snapshot to the index. Returns the input manifest unchanged when it is already indexed. */
export function withSnapshot(manifest: Manifest, snapshot: Snapshot): Manifest {
  const entry = manifestEntryFromSnapshot(snapshot);
  if (manifest.snapshots.some((existing) => existing.id === entry.id)) return manifest;
  return { ...manifest, snapshots: sortEntries([...manifest.snapshots, entry]) };
}

export function writeManifest(session: SessionPaths, manifest: Manifest): void {
  if (manifest.session !== session.name) {
    throw new StoreRefusal("manifest-session-mismatch", `Refusing to write manifest ${JSON.stringify(session.manifest)} for session ${JSON.stringify(manifest.session)}: it belongs to ${JSON.stringify(session.name)}.`);
  }
  ensureSessionDirectories(session);
  writeFileAtomic(session.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
}