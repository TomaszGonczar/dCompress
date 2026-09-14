/**
 * The single-writer session lock (CONCEPT §11.6, SCHEMA §8).
 *
 * The lock is *advisory on purpose*. Snapshot files are named from their envelope, so two writers
 * racing on one session produce two files rather than one damaged file; what the lock buys is a
 * serialized manifest index, not the protection of the snapshot itself. That is why a writer that
 * cannot take the lock still proceeds: after at most one second of waiting — the budget ends on
 * the injected clock, plus at most one observation interval for the OS to wake this thread — it
 * writes its own distinct snapshot and reports the live holder it waited for (CONCEPT §11.3,
 * "Store race"). Failing the caller would trade a quiet duplicate for a lost snapshot, which is
 * the worse of the two.
 *
 * A holder that is gone must not become a permanent block, so a record older than the stale
 * threshold whose pid no longer exists on this host is broken — reported as a value, and its bytes
 * kept beside the lock so the break can be inspected rather than believed. A pid recorded on
 * *another* host is deliberately not treated as dead: this writer cannot probe it, and claiming a
 * foreign process died would be a guess. Such a claim is waited out instead, which is bounded and
 * therefore never a permanent block either.
 */

import { hostname } from "node:os";

import type { Clock } from "../core/clock.js";
import { errnoCode, createExclusiveFile, preserveStateFile, readFileOrNull, refuseSymlinkedPath, removeStateFile } from "./fs.js";
import { readManifest, writeManifest } from "./manifest.js";
import { ensureSessionDirectories } from "./paths.js";
import { listSnapshots } from "./snapshot.js";
import { isLockRecord, utcInstantFrom } from "./types.js";
import type { BrokenLock, LockBreakReason, ManifestLock, ManifestWriteResult, SessionLock, SessionPaths } from "./types.js";

/** How long a writer waits for a live holder before it proceeds anyway (CONCEPT §11.6). */
export const DEFAULT_LOCK_WAIT_MS = 1_000;

/** How old a holder's record must be before a dead pid makes it breakable. */
export const DEFAULT_STALE_LOCK_MS = 30_000;

/**
 * The wait is a poll for the holder's release, so each look is a short, bounded interval. It is
 * also the most the wait can overshoot its window: the budget is measured on the injected clock
 * before each sleep, and the OS may return from that sleep a little late.
 */
export const LOCK_OBSERVATION_INTERVAL_MS = 50;

/** How many numbered copies of a broken record the store keeps before it stops filing them. */
const LOCK_EVIDENCE_LIMIT = 999;

export interface AcquireLockOptions {
  readonly session: SessionPaths;
  readonly clock: Clock;
  /** The host name written into the holder record; injected rather than read from the host. */
  readonly host?: string;
  readonly pid?: number;
  readonly waitMs?: number;
  readonly staleAfterMs?: number;
  /** Whether a pid recorded on this host is still running. */
  readonly isAlive?: (pid: number) => boolean;
  /** How the interval between observations passes; injected so a test can drive the boundary. */
  readonly sleep?: (ms: number) => void;
}

type ObservedLock =
  | { readonly status: "absent" }
  | { readonly status: "held"; readonly holder: ManifestLock }
  | { readonly status: "unreadable"; readonly reason: string };

/**
 * Wait without spinning. The store's write path is synchronous, so the wait has to be too:
 * `Atomics.wait` blocks this thread for the interval instead of consuming it.
 */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** `EPERM` means the pid exists and is not this process's to signal; only `ESRCH` means gone. */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}

function sameClaim(left: ManifestLock | null, right: ManifestLock | null): boolean {
  if (left === null || right === null) return left === right;
  return left.pid === right.pid && left.host === right.host && left.started_at === right.started_at;
}

function readLockFile(session: SessionPaths): ObservedLock {
  refuseSymlinkedPath(session.lock, "session lock");
  const raw = readFileOrNull(session.lock, "session lock");
  if (raw === null) return { status: "absent" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { status: "unreadable", reason: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!isLockRecord(value)) return { status: "unreadable", reason: "not a {pid, host, started_at} holder record" };
  return { status: "held", holder: value };
}

/**
 * The age of a holder that is stale, or `null` while it must be respected.
 *
 * Both conditions are required: old enough, and provably dead. A young record can belong to a
 * writer that is still inside its write, and an old record can belong to a writer that is merely
 * slow — neither is this writer's to break.
 */
function staleAge(holder: ManifestLock, nowMs: number, host: string, isAlive: (pid: number) => boolean, staleAfterMs: number): number | null {
  if (holder.host !== host) return null;
  const ageMs = nowMs - Date.parse(holder.started_at);
  if (ageMs <= staleAfterMs) return null;
  return isAlive(holder.pid) ? null : ageMs;
}

function breakLock(session: SessionPaths, holder: ManifestLock | null, reason: LockBreakReason, ageMs: number | null): BrokenLock {
  return { holder, reason, evidence_path: preserveStateFile(session.lock, ".broken", LOCK_EVIDENCE_LIMIT, "broken session lock"), age_ms: ageMs };
}

/**
 * Record (or clear) this writer's claim in the manifest index, persisting any repair the read
 * needed on the way.
 *
 * The index is the store's ordered description of what exists, and the lock field is part of it
 * (SCHEMA §8), so the claim is written where a reader already looks. `null` means nothing needed
 * writing: the index agreed with the directory and already said what it should.
 */
function recordHolder(session: SessionPaths, holder: ManifestLock | null, mine: ManifestLock): ManifestWriteResult | null {
  const listed = listSnapshots(session);
  const read = readManifest(session, listed.entries);
  const stored = read.manifest.lock;
  // Another writer's claim is not this writer's to drop; only `mine` is clearable here.
  const next = holder === null && stored !== null && !sameClaim(stored, mine) ? stored : holder;
  if (!read.rebuilt && sameClaim(stored, next)) return null;
  writeManifest(session, { ...read.manifest, lock: next });
  return { path: read.path, rebuilt: read.rebuilt, reason: read.reason };
}

/** Drop this writer's claim, then leave the index agreeing with the directory. */
function releaseLock(session: SessionPaths, mine: ManifestLock): ManifestWriteResult | null {
  const observed = readLockFile(session);
  if (observed.status === "held" && sameClaim(observed.holder, mine)) removeStateFile(session.lock, "session lock");
  return recordHolder(session, null, mine);
}

/**
 * Try to hold the session for one write.
 *
 * Returns a value in every case: holding the lock, waiting out a live holder, breaking a stale
 * one, or finding a record it could not read. It refuses only on a state error the caller has to
 * repair — a symlinked lock, an unreadable directory — never because the store is busy.
 */
export function acquireLock(options: AcquireLockOptions): SessionLock {
  const { session, clock } = options;
  const host = options.host ?? hostname();
  const pid = options.pid ?? process.pid;
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_LOCK_MS;
  const isAlive = options.isAlive ?? pidIsAlive;
  const sleep = options.sleep ?? sleepSync;

  ensureSessionDirectories(session);
  const startedMs = clock.now();
  const mine: ManifestLock = { pid, host, started_at: utcInstantFrom(startedMs) };
  const observations = Math.max(1, Math.ceil(waitMs / LOCK_OBSERVATION_INTERVAL_MS));
  // Breaking a stale lock is progress rather than waiting, so it does not spend the wait budget;
  // the iteration bound is what keeps a store that answers every look with a fresh broken record
  // from turning this loop into an unbounded one.
  const maxAttempts = observations * 2 + 1;

  let waitedMs = 0;
  let respected: ManifestLock | null = null;
  let broken: BrokenLock | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (createExclusiveFile(session.lock, `${JSON.stringify(mine, null, 2)}\n`)) {
      return { held: true, respected, broken, waited_ms: waitedMs, claim: recordHolder(session, mine, mine), release: () => releaseLock(session, mine) };
    }
    const observed = readLockFile(session);
    if (observed.status === "unreadable") {
      broken = breakLock(session, null, "unreadable", null);
      respected = null;
      continue;
    }
    if (observed.status === "held") {
      const ageMs = staleAge(observed.holder, clock.now(), host, isAlive, staleAfterMs);
      if (ageMs !== null) {
        broken = breakLock(session, observed.holder, "stale", ageMs);
        respected = null;
        continue;
      }
      respected = observed.holder;
    }
    // `absent` means the holder released between the create and the read; every path that reaches
    // here waits the same bounded interval before looking again.
    if (waitedMs >= waitMs) break;
    sleep(Math.min(LOCK_OBSERVATION_INTERVAL_MS, waitMs - waitedMs));
    waitedMs = clock.now() - startedMs;
  }

  return { held: false, respected, broken, waited_ms: waitedMs, claim: null, release: () => releaseLock(session, mine) };
}