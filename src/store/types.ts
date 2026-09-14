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