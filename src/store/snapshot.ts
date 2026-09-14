/**
 * Snapshot files: naming, atomic write, validated read, and quarantine.
 *
 * The file name is a function of the envelope — creation instant plus the short payload hash
 * (CONCEPT §6.3) — never of the clock at write time, so re-writing the same snapshot lands on
 * the same name and two events can never be confused for one another.
 *
 * A file that does not verify is moved aside rather than deleted or returned. Corruption is a
 * value in this module, not an exception: a directory read must survive one bad file to report
 * the rest, and the caller needs the fact of the quarantine to decide what to do next
 * (CONCEPT §11.3, "Corrupt snapshot").
 */

import { lstatSync, readFileSync, readdirSync, renameSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { payloadHash } from "../core/hash.js";
import type { Snapshot } from "../core/types.js";
import { errnoCode, lstatOrNull, refuseSymlinkedPath, stateRefusal, writeFileAtomic } from "./fs.js";
import { manifestEntryFromSnapshot, readManifest, snapshotId, withSnapshot, writeManifest } from "./manifest.js";
import { ensureSessionDirectories } from "./paths.js";
import { StoreRefusal, compareText, describeValue, isDegradedList, isHash, isInteger, isRecord, isUtcInstant } from "./types.js";
import type { SessionPaths, SnapshotListResult, SnapshotQuarantineCode, SnapshotReadQuarantined, SnapshotReadResult, WriteSnapshotResult } from "./types.js";

const FACT_KINDS: Record<string, true> = {
  "file.modified": true,
  "file.read": true,
  "file.created": true,
  "file.deleted": true,
  "cmd.run": true,
  "cmd.failed": true,
  "error.raised": true,
  "error.fixed": true,
  "decision.stated": true,
  "todo.state": true,
  "plan.state": true,
  "git.state": true,
  note: true,
};

const FACT_SCOPES: Record<string, true> = { repo: true, cwd: true, granted: true, external: true, uri: true };

const FACT_FIELDS: Record<string, true> = { at: true, attrs: true, evidence: true, key: true, kind: true, snippet: true, unbacked: true };
const COUNTER_FIELDS: Record<string, true> = { by_kind: true, coverage_ppm: true, external_path_count: true, facts: true, source_entries: true, source_tool_calls: true, unmapped_tool_calls: true };
const GIT_FIELDS: Record<string, true> = { branch: true, diff_stat: true, dirty: true, head: true, status_hash: true };
const DIFF_STAT_FIELDS: Record<string, true> = { added: true, files: true, removed: true };
const PLAN_FIELDS: Record<string, true> = { done: true, items: true, todos: true };

/** Filename: `<created_at>-<hash12>.json`, the derivation CONCEPT §6.3 names. */
export function snapshotFileName(envelope: Pick<Snapshot["envelope"], "created_at" | "hash">): string {
  if (!isUtcInstant(envelope.created_at)) {
    throw new StoreRefusal("invalid-snapshot", `Refusing to name a snapshot with envelope.created_at ${describeValue(envelope.created_at)}: a UTC instant at seconds precision is required (for example 2026-09-13T08:41:09Z).`);
  }
  if (!isHash(envelope.hash)) {
    throw new StoreRefusal("invalid-snapshot", `Refusing to name a snapshot with envelope.hash ${describeValue(envelope.hash)}: sha256:<64 lowercase hex characters> is required.`);
  }
  return `${envelope.created_at}-${envelope.hash.slice(7, 19)}.json`;
}

/** Reject keys the v1 shape does not define; a missing field is caught by its own type check. */
function unknownFieldReason(value: Record<string, unknown>, fields: Record<string, true>, label: string): string | null {
  const key = Object.keys(value).find((candidate) => fields[candidate] !== true);
  return key === undefined ? null : `${label} has an unknown field ${describeValue(key)}`;
}

function factReason(value: unknown): string | null {
  if (!isRecord(value)) return "fact is not an object";
  if (!FACT_KINDS[value.kind as string]) return `fact.kind ${describeValue(value.kind)} is not a v1 fact kind`;
  if (typeof value.key !== "string") return "fact.key is not a string";
  if (value.scope !== undefined && !FACT_SCOPES[value.scope as string]) return `fact.scope ${describeValue(value.scope)} is not a known scope`;
  // `scope` is the one optional fact field (SCHEMA §5.2); every other key must be a defined one.
  const unknownField = Object.keys(value).find((key) => FACT_FIELDS[key] !== true && key !== "scope");
  if (unknownField !== undefined) return `fact has an unknown field ${describeValue(unknownField)}`;
  if (!isRecord(value.at) || !isInteger(value.at.entry) || (value.at.ts !== null && typeof value.at.ts !== "string")) {
    return "fact.at must be {entry: non-negative integer, ts: string|null}";
  }
  if (!isRecord(value.attrs)) return "fact.attrs is not an object";
  if (!Array.isArray(value.evidence) || value.evidence.length > 5) return "fact.evidence must be an array of at most five entries";
  for (const evidence of value.evidence) {
    if (!isRecord(evidence)) return "fact.evidence entries must be objects";
    if (Object.keys(evidence).sort().join(",") !== "line,sha256") return "fact.evidence entries must be exactly {line, sha256}";
    if (!isInteger(evidence.line, 1)) return "evidence.line must be a positive integer";
    if (!isHash(evidence.sha256)) return "evidence.sha256 must be sha256:<64 lowercase hex characters>";
  }
  if (typeof value.snippet !== "string") return "fact.snippet is not a string";
  if (typeof value.unbacked !== "boolean") return "fact.unbacked is not a boolean";
  return null;
}

function countersReason(value: unknown): string | null {
  if (!isRecord(value)) return "payload.counters is not an object";
  const unknownField = unknownFieldReason(value, COUNTER_FIELDS, "payload.counters");
  if (unknownField !== null) return unknownField;
  for (const field of ["facts", "source_entries", "source_tool_calls", "unmapped_tool_calls", "coverage_ppm", "external_path_count"]) {
    if (!isInteger(value[field])) return `payload.counters.${field} is not a non-negative integer`;
  }
  if (!isRecord(value.by_kind)) return "payload.counters.by_kind is not an object";
  for (const [kind, count] of Object.entries(value.by_kind)) {
    if (!FACT_KINDS[kind]) return `payload.counters.by_kind names unknown kind ${describeValue(kind)}`;
    if (!isInteger(count)) return `payload.counters.by_kind.${kind} is not a non-negative integer`;
  }
  return null;
}

function gitReason(value: unknown): string | null {
  if (!isRecord(value)) return "payload.git is neither null nor an object";
  const unknownField = unknownFieldReason(value, GIT_FIELDS, "payload.git");
  if (unknownField !== null) return unknownField;
  if (typeof value.head !== "string" || typeof value.branch !== "string") return "payload.git.head and payload.git.branch must be strings";
  if (typeof value.dirty !== "boolean") return "payload.git.dirty is not a boolean";
  if (!isHash(value.status_hash)) return "payload.git.status_hash must be sha256:<64 lowercase hex characters>";
  if (!isRecord(value.diff_stat)) return "payload.git.diff_stat is not an object";
  const unknownStatField = unknownFieldReason(value.diff_stat, DIFF_STAT_FIELDS, "payload.git.diff_stat");
  if (unknownStatField !== null) return unknownStatField;
  for (const field of ["files", "added", "removed"]) {
    if (!isInteger(value.diff_stat[field])) return `payload.git.diff_stat.${field} is not a non-negative integer`;
  }
  return null;
}

function planReason(value: unknown): string | null {
  if (!isRecord(value)) return "payload.plan is neither null nor an object";
  const unknownField = unknownFieldReason(value, PLAN_FIELDS, "payload.plan");
  if (unknownField !== null) return unknownField;
  if (!isInteger(value.todos) || !isInteger(value.done)) return "payload.plan.todos and payload.plan.done must be non-negative integers";
  if (!Array.isArray(value.items) || value.items.some((item) => typeof item !== "string")) return "payload.plan.items must be an array of strings";
  return null;
}

function payloadReason(value: unknown): string | null {
  if (!isRecord(value)) return "payload is not an object";
  const fields: Record<string, true> = { counters: true, facts: true, git: true, path_base: true, plan: true, version: true };
  const unknownField = unknownFieldReason(value, fields, "payload");
  if (unknownField !== null) return unknownField;
  if (value.version !== 1) return `payload.version is ${describeValue(value.version)}, and only version 1 is readable`;
  if (value.path_base !== "repo" && value.path_base !== "cwd") return "payload.path_base is neither repo nor cwd";
  if (!Array.isArray(value.facts)) return "payload.facts is not an array";
  for (const [index, fact] of value.facts.entries()) {
    const reason = factReason(fact);
    if (reason !== null) return `payload.facts[${index}]: ${reason}`;
  }
  const counters = countersReason(value.counters);
  if (counters !== null) return counters;
  if (value.git !== null) {
    const git = gitReason(value.git);
    if (git !== null) return git;
  }
  if (value.plan !== null) {
    const plan = planReason(value.plan);
    if (plan !== null) return plan;
  }
  return null;
}

function envelopeReason(value: unknown): string | null {
  if (!isRecord(value)) return "envelope is not an object";
  if (typeof value.schema_version !== "string" || value.schema_version === "") return "envelope.schema_version is not a non-empty string";
  if (!isInteger(value.canonicalization, 1)) return "envelope.canonicalization is not a positive integer";
  if (typeof value.extractor_version !== "string" || value.extractor_version === "") return "envelope.extractor_version is not a non-empty string";
  if (!isUtcInstant(value.created_at)) return "envelope.created_at is not a UTC instant at seconds precision";
  // Adapter and session identity are checked for shape here and for equality against the
  // session directory in `listSnapshots`: a snapshot from a newer adapter must stay readable.
  if (typeof value.adapter !== "string" || value.adapter === "" || value.adapter.length > 32) return "envelope.adapter is not a bounded token";
  if (value.adapter_version !== null && typeof value.adapter_version !== "string") return "envelope.adapter_version is neither null nor a string";
  if (value.session_id !== null && !(typeof value.session_id === "string" && value.session_id.length > 0 && value.session_id.length <= 128)) return "envelope.session_id is neither null nor a bounded token";
  if (value.transcript_path !== null && typeof value.transcript_path !== "string") return "envelope.transcript_path is neither null nor a string";
  if (!isInteger(value.transcript_bytes)) return "envelope.transcript_bytes is not a non-negative integer";
  if (!isInteger(value.transcript_lines)) return "envelope.transcript_lines is not a non-negative integer";
  if (value.transcript_mtime !== null && typeof value.transcript_mtime !== "string") return "envelope.transcript_mtime is neither null nor a string";
  if (!isRecord(value.host) || typeof value.host.os !== "string" || typeof value.host.arch !== "string" || typeof value.host.node !== "string") return "envelope.host must carry string os, arch, and node";
  if (!isRecord(value.store) || typeof value.store.cwd !== "string" || (value.store.repo_root !== null && typeof value.store.repo_root !== "string")) return "envelope.store must carry cwd and repo_root";
  if (!isDegradedList(value.degraded)) return "envelope.degraded contains an unknown state token";
  if (value.previous_hash !== null && !isHash(value.previous_hash)) return "envelope.previous_hash is neither null nor sha256:<64 lowercase hex characters>";
  if (!isInteger(value.duration_ms)) return "envelope.duration_ms is not a non-negative integer";
  if (!isHash(value.hash)) return "envelope.hash is not sha256:<64 lowercase hex characters>";
  return null;
}

/**
 * Structural validation of a stored snapshot.
 *
 * Unknown *envelope* fields are tolerated: adding one is a compatible change that must not
 * invalidate a stored file (SCHEMA §6.1, §9). Unknown payload fields are not, because the
 * payload is versioned and a field it does not define means the bytes are not what they claim.
 */
function validateSnapshotShape(value: unknown): string | null {
  if (!isRecord(value)) return "the snapshot is not an object";
  const unknownField = Object.keys(value).find((key) => key !== "envelope" && key !== "payload");
  if (unknownField !== undefined) return `the snapshot has an unknown field ${describeValue(unknownField)}`;
  const envelope = envelopeReason(value.envelope);
  if (envelope !== null) return `envelope: ${envelope}`;
  return payloadReason(value.payload);
}

function quarantineTarget(path: string): string {
  const base = `${path}.corrupt`;
  if (lstatOrNull(base, "quarantine file") === null) return base;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${path}.corrupt.${index}`;
    if (lstatOrNull(candidate, "quarantine file") === null) return candidate;
  }
  throw new StoreRefusal("quarantine-unavailable", `Refusing to quarantine ${JSON.stringify(path)}: 999 quarantine files already sit beside it. Move or delete the *.corrupt files and retry.`);
}

/** Move a file that cannot be returned as usable out of the way, keeping its bytes for repair. */
function quarantine(path: string, code: SnapshotQuarantineCode, reason: string): SnapshotReadQuarantined {
  const target = quarantineTarget(path);
  try {
    renameSync(path, target);
  } catch (error) {
    throw stateRefusal(error, path, "snapshot file", "file") ?? error;
  }
  return { status: "quarantined", path, quarantinePath: target, code, reason };
}

export interface ReadSnapshotOptions {
  /** `false` skips the hash comparison only, for a repair path. Shape and canonical form still hold. */
  readonly verify?: boolean;
}

/**
 * Read one snapshot file.
 *
 * `envelope.hash` is recomputed from the payload and compared by default; a mismatch, a parse
 * failure, or an invalid shape quarantines the file instead of returning it.
 */
export function readSnapshot(path: string, options: ReadSnapshotOptions = {}): SnapshotReadResult {
  refuseSymlinkedPath(path, "snapshot file");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw stateRefusal(error, path, "snapshot file", "file") ?? new StoreRefusal("snapshot-unreadable", `Cannot read snapshot ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return quarantine(path, "unparseable", `not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }

  const shape = validateSnapshotShape(value);
  if (shape !== null) return quarantine(path, "invalid-shape", shape);

  const snapshot = value as Snapshot;
  let computed: string;
  try {
    computed = payloadHash(snapshot.payload);
  } catch (error) {
    return quarantine(path, "payload-invalid", `the payload cannot be canonicalized (${error instanceof Error ? error.message : String(error)})`);
  }
  if (computed !== snapshot.envelope.hash) {
    if (options.verify === false) return { status: "ok", path, snapshot, verified: false };
    return quarantine(path, "hash-mismatch", `payload hashes to ${computed} but the envelope claims ${snapshot.envelope.hash}`);
  }
  return { status: "ok", path, snapshot, verified: options.verify !== false };
}

function readSnapshotIfPresent(path: string): SnapshotReadResult | null {
  try {
    lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw stateRefusal(error, path, "snapshot file", "file") ?? error;
  }
  return readSnapshot(path);
}

/**
 * Every usable snapshot in one session store, oldest first.
 *
 * Names that are not `<something>.json` are ignored: a partial write leaves only a `*.tmp-*`
 * file, and a quarantined file is `*.corrupt`, so neither can be mistaken for a snapshot.
 * A snapshot carrying a different session identity is quarantined: injecting another session's
 * facts is the failure AGENTS invariant 8 exists to prevent.
 */
export function listSnapshots(session: SessionPaths): SnapshotListResult {
  refuseSymlinkedPath(session.session, "session directory");
  refuseSymlinkedPath(session.snapshots, "snapshot directory");
  let dirents: Dirent[];
  try {
    dirents = readdirSync(session.snapshots, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { snapshots: [], entries: [], quarantined: [] };
    throw stateRefusal(error, session.snapshots, "snapshot directory") ?? error;
  }

  const quarantined: SnapshotReadQuarantined[] = [];
  const byId = new Map<string, Snapshot>();
  for (const name of dirents.filter((dirent) => dirent.name.endsWith(".json") && !dirent.isDirectory()).map((dirent) => dirent.name).sort(compareText)) {
    const path = join(session.snapshots, name);
    const result = readSnapshot(path);
    if (result.status === "quarantined") {
      quarantined.push(result);
      continue;
    }
    const { envelope } = result.snapshot;
    if (envelope.adapter !== session.adapter || envelope.session_id !== session.sessionId) {
      quarantined.push(quarantine(path, "session-mismatch", `the envelope carries ${describeValue(envelope.adapter)}/${describeValue(envelope.session_id)} but the file sits in session ${describeValue(session.name)}`));
      continue;
    }
    byId.set(snapshotId(envelope.created_at, envelope.hash), result.snapshot);
  }

  const snapshots = [...byId.values()].sort((left, right) => compareText(left.envelope.created_at, right.envelope.created_at) || compareText(left.envelope.hash, right.envelope.hash));
  return { snapshots, entries: snapshots.map(manifestEntryFromSnapshot), quarantined };
}

export interface WriteSnapshotOptions {
  readonly session: SessionPaths;
  readonly snapshot: Snapshot;
}

/**
 * Write one snapshot and index it.
 *
 * The write is refused unless the artifact is internally consistent: a snapshot whose
 * `envelope.hash` is not `payloadHash(payload)` is a plausible-looking file that can never
 * verify, so it must not reach the store in the first place.
 */
export function writeSnapshot(options: WriteSnapshotOptions): WriteSnapshotResult {
  const { session, snapshot } = options;
  const shape = validateSnapshotShape(snapshot);
  if (shape !== null) throw new StoreRefusal("invalid-snapshot", `Refusing to write a snapshot whose shape is invalid (${shape}).`);
  let computed: string;
  try {
    computed = payloadHash(snapshot.payload);
  } catch (error) {
    throw new StoreRefusal("invalid-snapshot", `Refusing to write a snapshot whose payload cannot be canonicalized (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (computed !== snapshot.envelope.hash) {
    throw new StoreRefusal("snapshot-hash-mismatch", `Refusing to write a snapshot whose envelope.hash ${JSON.stringify(snapshot.envelope.hash)} is not payloadHash(payload) ${computed}; recompute the hash rather than store a self-inconsistent artifact.`);
  }

  ensureSessionDirectories(session);
  const path = join(session.snapshots, snapshotFileName(snapshot.envelope));
  // The index is read before the file lands so that `rebuilt` describes the state a user can
  // act on — a manifest that was missing or behind *before* this write, not one this write
  // itself made stale.
  const manifestRead = readManifest(session, listSnapshots(session).entries);

  let created = true;
  const existing = readSnapshotIfPresent(path);
  if (existing !== null && existing.status === "ok") {
    if (existing.snapshot.envelope.hash !== snapshot.envelope.hash) {
      throw new StoreRefusal("snapshot-name-collision", `Refusing to overwrite ${JSON.stringify(path)}: it holds ${existing.snapshot.envelope.hash} while this snapshot is ${snapshot.envelope.hash}. Two different payloads would share one name; move the file aside or snapshot a different creation instant.`);
    }
    // Same payload and same creation instant: the file already is this snapshot.
    created = false;
  }
  if (created) writeFileAtomic(path, `${JSON.stringify(snapshot, null, 2)}\n`);

  const next = withSnapshot(manifestRead.manifest, snapshot);
  if (next !== manifestRead.manifest) writeManifest(session, next);
  return { path, created, manifest: { path: session.manifest, rebuilt: manifestRead.rebuilt, reason: manifestRead.reason } };
}