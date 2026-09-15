/**
 * Retention: fifteen snapshots or seventy-two hours, whichever comes first (CONCEPT §10,
 * SCHEMA §8).
 *
 * Two rules, in this order, and the order is the point. The age rule runs first because it is the
 * one a clock can lie about: a VM resume, a DST change, or a jump forward makes an entire store
 * look ancient at once, and the newest snapshot is what such a pass would otherwise delete. The
 * newest is therefore not a candidate for either rule, and a pinned snapshot is not a candidate
 * either — a pin is the user's explicit statement that a snapshot outlives the policy.
 *
 * The count rule then trims the oldest survivors until the store is back inside the budget. It
 * counts every snapshot the pass retains, newest and pinned included, so "fifteen snapshots or
 * seventy-two hours" keeps meaning a bound on what is on disk. When exemptions leave more than the
 * budget in place, nothing is invented to fix it: `kept` and `pruned` describe the store as it
 * now is, and the caller can see that the policy could not be met without breaking a pin.
 *
 * Time comes from the injected clock and never from `Date.now()`; the deletions are recorded in
 * `manifest.pruned[]` with the reason and the instant, so what was deleted and why stays visible
 * after the files are gone.
 */

import { join } from "node:path";

import type { Clock } from "../core/clock.js";
import { removeStateFile, refuseSymlinkedPath } from "./fs.js";
import { readManifest, writeManifest } from "./manifest.js";
import { listSnapshots, snapshotFileName } from "./snapshot.js";
import { compareText, utcInstantFrom } from "./types.js";
import type { ManifestPrunedEntry, ManifestSnapshotEntry, ManifestWriteResult, PrunedSnapshot, RetentionCandidate, RetentionPlan, RetentionPolicy, RetentionResult, SessionPaths } from "./types.js";

/** The product policy, in one place: fifteen snapshots or seventy-two hours. */
export const RETENTION_POLICY: RetentionPolicy = Object.freeze({ maxSnapshots: 15, maxAgeMs: 72 * 60 * 60 * 1000 });

export interface RetentionOptions {
  readonly session: SessionPaths;
  readonly clock: Clock;
  readonly policy?: RetentionPolicy;
  /** Report the same set the pass would delete, and delete nothing. */
  readonly dryRun?: boolean;
}

/**
 * Which entries a pass at `nowMs` selects, oldest first. Pure: no clock, no filesystem.
 *
 * An entry is expired when it is strictly older than `maxAgeMs`; an entry exactly at the boundary
 * is retained, because the product promise is a bound on how long a snapshot may be kept, not a
 * way to delete one at the instant it reaches it.
 */
export function planRetention(entries: readonly ManifestSnapshotEntry[], nowMs: number, policy: RetentionPolicy = RETENTION_POLICY): RetentionPlan {
  const ordered = [...entries].sort((left, right) => compareText(left.created_at, right.created_at) || compareText(left.id, right.id));
  const newest = ordered.length - 1;
  const candidates = ordered
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry, index }) => index !== newest && !entry.pinned);

  const selected = new Map<number, RetentionCandidate["reason"]>();
  for (const { entry, index } of candidates) {
    if (nowMs - Date.parse(entry.created_at) > policy.maxAgeMs) selected.set(index, "retention:age");
  }
  let retained = ordered.length - selected.size;
  for (const { index } of candidates) {
    if (retained <= policy.maxSnapshots) break;
    if (selected.has(index)) continue;
    selected.set(index, "retention:count");
    retained -= 1;
  }

  return {
    kept: ordered.filter((_, index) => !selected.has(index)),
    pruned: [...selected].map(([index, reason]) => ({ entry: ordered[index], reason })),
  };
}

/** Record the prunes in the index, persisting any repair the read needed on the way. */
function recordPrunes(session: SessionPaths, pruned: readonly PrunedSnapshot[]): ManifestWriteResult | null {
  const listed = listSnapshots(session);
  const read = readManifest(session, listed.entries);
  if (pruned.length === 0 && !read.rebuilt) return null;
  const records: ManifestPrunedEntry[] = pruned.map((entry) => ({ hash: entry.hash, reason: entry.reason, at: entry.at }));
  writeManifest(session, { ...read.manifest, pruned: [...read.manifest.pruned, ...records] });
  return { path: read.path, rebuilt: read.rebuilt, reason: read.reason };
}

/**
 * Evaluate retention for one session, delete what it selects, and record the deletions.
 *
 * A dry run deletes nothing, writes nothing, and returns the pass it would have performed, so the
 * two modes report the same set and can be compared directly.
 */
export function applyRetention(options: RetentionOptions): RetentionResult {
  const { session, clock } = options;
  const policy = options.policy ?? RETENTION_POLICY;
  const dryRun = options.dryRun === true;
  const nowMs = clock.now();
  const at = utcInstantFrom(nowMs);

  const listed = listSnapshots(session);
  const read = readManifest(session, listed.entries);
  const plan = planRetention(read.manifest.snapshots, nowMs, policy);
  const kept = plan.kept.map((entry) => entry.id);
  const planned: PrunedSnapshot[] = plan.pruned.map(({ entry, reason }) => ({
    path: join(session.snapshots, snapshotFileName(entry)),
    id: entry.id,
    hash: entry.hash,
    created_at: entry.created_at,
    reason,
    at,
  }));

  if (dryRun) return { policy, now: at, dryRun: true, kept, pruned: planned, manifest: null };

  const deleted: PrunedSnapshot[] = [];
  let manifest: ManifestWriteResult | null = null;
  try {
    for (const entry of planned) {
      refuseSymlinkedPath(entry.path, "snapshot file");
      removeStateFile(entry.path, "snapshot file");
      deleted.push(entry);
    }
  } finally {
    // The audit trail describes what this pass actually deleted, so it is written even when a
    // later deletion refused: an index listing files that are gone is the worse outcome, and the
    // refusal still reaches the caller because `finally` does not swallow it.
    manifest = recordPrunes(session, deleted);
  }
  return { policy, now: at, dryRun: false, kept, pruned: deleted, manifest };
}