/**
 * Shared vocabulary for the store: refusals, path shapes, read results, and the shape
 * predicates both the snapshot and manifest validators need.
 *
 * Nothing here is hashed. `manifest.json` and the store layout are operational metadata; the
 * artifact's identity stays `payloadHash(payload)` inside the envelope (SCHEMA §6).
 */

import type { DegradedState, Snapshot } from "../core/types.js";

/**
 * An operational failure the caller must act on, in the typed-refusal style of
 * `src/continuity.ts`.
 *
 * Corruption is deliberately *not* a refusal: a quarantined snapshot is a recorded outcome, so
 * it travels back as a value from `readSnapshot` instead of interrupting a read path that has
 * to keep going over the rest of the directory.
 */
export class StoreRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreRefusal";
    this.code = code;
  }
}

/** The environment a store root is resolved from. Read at the I/O boundary, never in core. */
export interface StoreEnvironment {
  readonly DCOMPACT_HOME?: string;
  readonly XDG_DATA_HOME?: string;
  readonly HOME?: string;
}

export interface SessionLocator {
  readonly adapter: string;
  readonly sessionId: string;
  /** An explicit store root (`--store`, `dcompact init`) wins over the environment. */
  readonly root?: string;
  readonly env?: StoreEnvironment;
}

/** Every path the store derives for one explicitly named session. */
export interface SessionPaths {
  readonly root: string;
  readonly adapter: string;
  readonly sessionId: string;
  /** `<adapter>-<session_id>`: the session directory name and `manifest.session`. */
  readonly name: string;
  readonly sessions: string;
  readonly session: string;
  readonly snapshots: string;
  readonly manifest: string;
  /** The single-writer lock named by CONCEPT §6.3; the lock module owns writing it. */
  readonly lock: string;
}

export type SnapshotQuarantineCode =
  | "unparseable"
  | "invalid-shape"
  | "payload-invalid"
  | "hash-mismatch"
  | "session-mismatch";

export interface SnapshotReadOk {
  readonly status: "ok";
  readonly path: string;
  readonly snapshot: Snapshot;
  /** False only when the caller explicitly asked to skip hash verification. */
  readonly verified: boolean;
}

export interface SnapshotReadQuarantined {
  readonly status: "quarantined";
  readonly path: string;
  /** Where the unusable file was moved, never deleted. */
  readonly quarantinePath: string;
  readonly code: SnapshotQuarantineCode;
  readonly reason: string;
}

export type SnapshotReadResult = SnapshotReadOk | SnapshotReadQuarantined;

export interface SnapshotListResult {
  /** Usable snapshots, ordered oldest first. */
  readonly snapshots: readonly Snapshot[];
  /** The same snapshots as manifest entries, in the same order. */
  readonly entries: readonly ManifestSnapshotEntry[];
  readonly quarantined: readonly SnapshotReadQuarantined[];
}

export interface ManifestSnapshotEntry {
  /** `<created_at>|<hash>` (SCHEMA §2). */
  readonly id: string;
  readonly hash: string;
  readonly created_at: string;
  readonly facts: number;
  readonly pinned: boolean;
  readonly degraded: readonly DegradedState[];
}

export type PruneReason = "retention:count" | "retention:age" | "manual" | "corrupt";

export interface ManifestPrunedEntry {
  readonly hash: string;
  readonly reason: PruneReason;
  readonly at: string;
}

export interface ManifestLock {
  readonly pid: number;
  readonly host: string;
  readonly started_at: string;
}

/** Why a lock the store could not trust was broken (CONCEPT §11.3, "Store race"). */
export type LockBreakReason = "stale" | "unreadable";

export interface BrokenLock {
  /** The broken holder, or `null` when its record could not be read at all. */
  readonly holder: ManifestLock | null;
  readonly reason: LockBreakReason;
  /** Where the broken record's bytes were preserved; `null` when the store could not file them. */
  readonly evidence_path: string | null;
  /** The broken record's age, or `null` when its `started_at` was unreadable. */
  readonly age_ms: number | null;
}

/**
 * The result of one writer's attempt to hold a session.
 *
 * `held: false` is not a failure: the store's writers write under distinct names, so a writer
 * that waited out a live holder proceeds and reports `respected` rather than failing its caller.
 */
export interface SessionLock {
  readonly held: boolean;
  /** The live holder this writer waited out, `null` when it never had to wait for one. */
  readonly respected: ManifestLock | null;
  readonly broken: BrokenLock | null;
  /** How long this writer waited, measured on the injected clock. */
  readonly waited_ms: number;
  /** The index write that recorded the claim, `null` when this writer never held the lock. */
  readonly claim: ManifestWriteResult | null;
  /**
   * Drop this writer's claim and leave the index agreeing with the directory.
   *
   * Returns the index write this performed, including a repair of an index that had fallen behind
   * the snapshot files, or `null` when there was nothing to write. Safe to call more than once,
   * and safe to call when the loop never held the lock.
   */
  release(): ManifestWriteResult | null;
}

/** How many snapshots a session keeps and how old one may be: CONCEPT §10, 15 or 72 h. */
export interface RetentionPolicy {
  readonly maxSnapshots: number;
  readonly maxAgeMs: number;
}

export interface PrunedSnapshot {
  readonly path: string;
  /** `<created_at>|<hash>`, the same id the manifest index uses. */
  readonly id: string;
  readonly hash: string;
  readonly created_at: string;
  readonly reason: PruneReason;
  /** The instant of this prune, from the injected clock. */
  readonly at: string;
}

/** One snapshot the policy selects, with the reason it was selected. */
export interface RetentionCandidate {
  readonly entry: ManifestSnapshotEntry;
  readonly reason: Extract<PruneReason, "retention:count" | "retention:age">;
}

/** What the policy selects for one evaluation, before anything is deleted or written. */
export interface RetentionPlan {
  /** The index entries that survive, oldest first. */
  readonly kept: readonly ManifestSnapshotEntry[];
  /** The entries the policy selects for deletion, age before count. */
  readonly pruned: readonly RetentionCandidate[];
}

export interface RetentionResult {
  readonly policy: RetentionPolicy;
  /** The instant the pass was evaluated at, from the injected clock. */
  readonly now: string;
  /** True when nothing was deleted and nothing was written. */
  readonly dryRun: boolean;
  /** Ids that survive this pass, oldest first. Pins and the newest snapshot are never pruned. */
  readonly kept: readonly string[];
  /** What this pass deleted, or on a dry run exactly what it would have deleted. */
  readonly pruned: readonly PrunedSnapshot[];
  /** The index write that recorded the prunes, or `null` when the pass changed nothing. */
  readonly manifest: ManifestWriteResult | null;
}

/** `manifest.json` (SCHEMA §8), outside any hash. */
export interface Manifest {
  readonly manifest_version: 1;
  readonly session: string;
  readonly snapshots: readonly ManifestSnapshotEntry[];
  readonly pruned: readonly ManifestPrunedEntry[];
  /** Null when no writer holds the session lock; the lock module owns this field. */
  readonly lock: ManifestLock | null;
}

export type ManifestRebuildReason = "missing" | "unparseable" | "inconsistent";

export interface ManifestReadResult {
  readonly path: string;
  readonly manifest: Manifest;
  /** True when the stored file was missing, unparseable, or disagreed with the snapshot files. */
  readonly rebuilt: boolean;
  readonly reason: ManifestRebuildReason | null;
}

export interface ManifestWriteResult {
  readonly path: string;
  readonly rebuilt: boolean;
  readonly reason: ManifestRebuildReason | null;
}

export interface WriteSnapshotResult {
  readonly path: string;
  /** False when an identical snapshot already occupied the derived name. */
  readonly created: boolean;
  readonly manifest: ManifestWriteResult;
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Wall-clock instants are UTC at seconds precision (SCHEMA §2); `T…Z` only, no offset form. */
const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Every finite state from CONCEPT §11.2; a token outside this table is drift, not a state. */
const DEGRADED_STATES: Record<DegradedState, true> = {
  ok: true,
  "schema-drift": true,
  "extraction-empty": true,
  "provenance-broken": true,
  "budget-exceeded": true,
  "internal-error": true,
  "unavailable:agent-not-installed": true,
  "unavailable:store": true,
  "untrusted:hook-pending-review": true,
  "no-pre-compaction-hook": true,
};

export function isDegradedList(value: unknown): value is DegradedState[] {
  return Array.isArray(value) && value.every((token) => typeof token === "string" && DEGRADED_STATES[token as DegradedState] === true);
}

export function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

/**
 * Structural check only: the instant must round-trip through UTC at seconds precision, which
 * also rejects overflow dates such as `2026-02-30T00:00:00Z`.
 */
export function isUtcInstant(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_INSTANT_PATTERN.test(value)) return false;
  return new Date(value).toISOString().replace(/\.000Z$/, "Z") === value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const LOCK_RECORD_FIELDS: Record<string, true> = { host: true, pid: true, started_at: true };

/**
 * A lock holder record (SCHEMA §8): the shape both `manifest.lock` and the session lock file
 * carry, so one reader can be sure of what the other wrote. Unknown fields are rejected: a
 * record dcompact does not understand is not a holder it can reason about.
 */
export function isLockRecord(value: unknown): value is ManifestLock {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.every((key) => LOCK_RECORD_FIELDS[key] === true)) return false;
  if (!isInteger(value.pid, 1)) return false;
  if (typeof value.host !== "string" || value.host.length === 0) return false;
  return isUtcInstant(value.started_at);
}

/**
 * The inverse of `isUtcInstant`: a wall-clock millisecond count at the seconds precision every
 * stored instant uses. Truncating rather than rounding keeps an instant from ever naming a moment
 * that has not happened yet.
 */
export function utcInstantFrom(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) {
    throw new StoreRefusal("invalid-instant", `Cannot form a UTC instant from ${describeValue(milliseconds)}; the clock must return a finite millisecond count.`);
  }
  return new Date(Math.floor(milliseconds / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");
}

/** Payload integers are non-negative by construction; `minimum` raises the floor where needed. */
export function isInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/** Cap untrusted text before it reaches a refusal message. */
export function describeValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return JSON.stringify(text.length > 64 ? `${text.slice(0, 64)}…` : text);
}

/**
 * Code-point ordering, the rule canonicalization uses (SCHEMA §5.1).
 *
 * The store's file order is never hashed, but it still must not depend on the host's ICU data:
 * `localeCompare` would order the same store differently on two machines.
 */
export function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}