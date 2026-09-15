/**
 * `dcompress doctor` — a health report over one explicitly named session's store (CONCEPT
 * §6.2, §11.2; DEVELOPMENT_PLAN P7/D7).
 *
 * Every value here is read from the store's own return values — `listSnapshots`,
 * `readManifest`, `acquireLock` — rather than a second inspection path that could disagree
 * with the one that actually reads and writes snapshots. Doctor never guesses a session
 * (AGENTS invariant 8): the adapter and session id are required inputs, exactly like every
 * other continuity command; nothing here scans for "the most recent" session.
 *
 * Lock inspection takes the lock for an instant (`waitMs: 0`, never blocking on a live
 * holder) and releases it immediately, because `acquireLock`'s stale-break and live-holder
 * detection is the store's only implementation of that logic; duplicating it here to stay
 * "read-only" would be a second source of truth that can drift from the one writers use.
 */

import { fixedClock } from "./core/clock.js";
import type { Clock } from "./core/clock.js";
import { mergeCheckpointPayloads } from "./core/continuity.js";
import { DEFAULT_MAX_BYTES, renderPack } from "./core/pack.js";
import type { DegradedState, Payload } from "./core/types.js";
import { DEFAULT_STALE_LOCK_MS, acquireLock } from "./store/lock.js";
import { readManifest } from "./store/manifest.js";
import { sessionPaths } from "./store/paths.js";
import { listSnapshots } from "./store/snapshot.js";
import { StoreRefusal } from "./store/types.js";
import type { BrokenLock, ManifestLock, ManifestReadResult, ManifestRebuildReason, SessionPaths, SnapshotListResult, SnapshotQuarantineCode } from "./store/types.js";
import { EXIT_DEGRADED, EXIT_INTEGRITY_FAILURE, EXIT_OK, EXIT_OPERATIONAL_FAILURE } from "./exit-codes.js";

export interface DoctorOptions {
  readonly adapter: string;
  readonly sessionId: string;
  /** Explicit `--store`; task-owned, never a live agent's real store (AGENTS "What not to do"). */
  readonly root: string;
  readonly clock?: Clock;
  /** The budget doctor renders the merged pack against to check for `budget-exceeded`. */
  readonly maxBytes?: number;
  /** Lock-inspection overrides, for deterministic tests only. */
  readonly host?: string;
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
  readonly staleAfterMs?: number;
}

export interface DoctorStoreReport {
  readonly root: string;
  readonly session: string;
  readonly usable: boolean;
  /** The refusal message, verbatim, when `usable` is false. */
  readonly refusal: string | null;
}

export interface DoctorManifestReport {
  readonly rebuilt: boolean;
  readonly reason: ManifestRebuildReason | null;
}

export interface DoctorSnapshotIdentity {
  /** `<created_at>|<hash>`, the same id the manifest index uses. */
  readonly id: string;
  readonly created_at: string;
  readonly hash: string;
}

export interface DoctorSnapshotsReport {
  readonly count: number;
  readonly newest: DoctorSnapshotIdentity | null;
}

export interface DoctorQuarantineReport {
  readonly path: string;
  readonly code: SnapshotQuarantineCode;
  readonly reason: string;
}

export interface DoctorLockReport {
  readonly held: boolean;
  readonly respected: ManifestLock | null;
  readonly broken: BrokenLock | null;
  readonly waited_ms: number;
}

export interface DoctorAdapterHealth {
  readonly coverage_ppm: number | null;
  readonly unmapped_tool_calls: number | null;
  readonly by_kind: Record<string, number> | null;
  /**
   * A genuine per-tool-call-name histogram is not persisted anywhere in the schema today:
   * `PayloadCounters` stores the fact-*kind* histogram (`by_kind`) and the aggregate
   * `unmapped_tool_calls` count only (SCHEMA §8, CONCEPT §4.1.1). Reporting `by_kind` under a
   * "tool name" label would misname a fact kind as a tool; `null` is the honest value until a
   * per-tool-name counter exists (owned by P5, the adapter framework).
   */
  readonly by_tool_name: null;
}

export interface DoctorReport {
  readonly adapter: string;
  readonly session_id: string;
  readonly store: DoctorStoreReport;
  readonly manifest: DoctorManifestReport | null;
  readonly snapshots: DoctorSnapshotsReport;
  readonly quarantined: readonly DoctorQuarantineReport[];
  readonly lock: DoctorLockReport | null;
  readonly adapter_health: DoctorAdapterHealth;
  /** Every degraded/unavailable state from CONCEPT §11.2 currently in effect for this session. */
  readonly degraded: readonly DegradedState[];
}

const NO_ADAPTER_HEALTH: DoctorAdapterHealth = Object.freeze({ coverage_ppm: null, unmapped_tool_calls: null, by_kind: null, by_tool_name: null });

/**
 * Recover the finite tokens `renderPack`'s header actually rendered.
 *
 * `renderPack` computes `budget-exceeded` internally (it may add the token to the header even
 * when the caller did not pass it) and returns only the rendered string, so this is the one
 * place that state becomes visible again rather than a second budget computation.
 */
function statusTokens(pack: string): DegradedState[] {
  const match = /^Status: (.+)$/m.exec(pack);
  if (!match || match[1] === "ok") return [];
  return match[1].split(", ").map((token) => token.replace(/^degraded: /, "") as DegradedState);
}

export function doctor(options: DoctorOptions): DoctorReport {
  // `sessionPaths` is pure string validation (no filesystem access): a throw here means the
  // caller supplied a malformed session id, adapter id, or store path, not that the store is
  // unavailable. Left to propagate so the CLI reports it as a usage mistake, never as a
  // reduced-mode store.
  const paths: SessionPaths = sessionPaths({ adapter: options.adapter, sessionId: options.sessionId, root: options.root });
  const clock = options.clock ?? fixedClock(Date.now());

  let listed: SnapshotListResult;
  let manifestRead: ManifestReadResult;
  let lock: DoctorLockReport;
  try {
    listed = listSnapshots(paths);
    manifestRead = readManifest(paths, listed.entries);
    const held = acquireLock({
      session: paths,
      clock,
      host: options.host,
      pid: options.pid,
      waitMs: 0,
      staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_LOCK_MS,
      isAlive: options.isAlive,
    });
    held.release();
    lock = { held: held.held, respected: held.respected, broken: held.broken, waited_ms: held.waited_ms };
  } catch (error) {
    if (!(error instanceof StoreRefusal)) throw error;
    return {
      adapter: paths.adapter,
      session_id: paths.sessionId,
      store: { root: paths.root, session: paths.session, usable: false, refusal: error.message },
      manifest: null,
      snapshots: { count: 0, newest: null },
      quarantined: [],
      lock: null,
      adapter_health: NO_ADAPTER_HEALTH,
      degraded: ["unavailable:store"],
    };
  }

  const quarantined: DoctorQuarantineReport[] = listed.quarantined.map((entry) => ({ path: entry.path, code: entry.code, reason: entry.reason }));
  const newest = listed.snapshots.at(-1) ?? null;

  let adapterHealth = NO_ADAPTER_HEALTH;
  let degraded: DegradedState[] = [...new Set(listed.snapshots.flatMap((snapshot) => snapshot.envelope.degraded))];

  if (listed.snapshots.length > 0) {
    const merged: Payload = mergeCheckpointPayloads(listed.snapshots.map((snapshot) => snapshot.payload));
    if (merged.facts.some((fact) => fact.unbacked)) degraded.push("provenance-broken");
    degraded = [...new Set(degraded)];
    adapterHealth = { coverage_ppm: merged.counters.coverage_ppm, unmapped_tool_calls: merged.counters.unmapped_tool_calls, by_kind: merged.counters.by_kind, by_tool_name: null };

    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    try {
      degraded = [...new Set(statusTokens(renderPack(merged, { maxBytes, degraded })))];
    } catch {
      // A maxBytes too small even for the mandatory header/notice cannot render at all; the
      // budget is exceeded either way, so the state is still reported rather than losing it.
      degraded = [...new Set([...degraded, "budget-exceeded" as const])];
    }
  }
  degraded.sort();

  return {
    adapter: paths.adapter,
    session_id: paths.sessionId,
    store: { root: paths.root, session: paths.session, usable: true, refusal: null },
    manifest: { rebuilt: manifestRead.rebuilt, reason: manifestRead.reason },
    snapshots: { count: listed.snapshots.length, newest: newest ? { id: `${newest.envelope.created_at}|${newest.envelope.hash}`, created_at: newest.envelope.created_at, hash: newest.envelope.hash } : null },
    quarantined,
    lock,
    adapter_health: adapterHealth,
    degraded,
  };
}

/** CONCEPT §6.2 exit codes, applied to one doctor outcome. Precedence: the worse state wins. */
export function doctorExitCode(report: DoctorReport): number {
  if (!report.store.usable) return EXIT_OPERATIONAL_FAILURE;
  const integrityFailure = report.quarantined.length > 0 || report.degraded.includes("provenance-broken");
  if (integrityFailure) return EXIT_INTEGRITY_FAILURE;
  const degradedButUsable = report.degraded.length > 0 || report.lock?.broken != null;
  if (degradedButUsable) return EXIT_DEGRADED;
  return EXIT_OK;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`session: ${report.adapter}/${report.session_id}`);
  lines.push(`store: ${report.store.session} | usable: ${report.store.usable}`);
  if (!report.store.usable) {
    lines.push(`refusal: ${report.store.refusal}`);
    lines.push(`health: ${report.degraded.length === 0 ? "ok" : report.degraded.join(", ")}`);
    return lines.join("\n");
  }
  if (report.manifest) lines.push(`manifest: ${report.manifest.rebuilt ? `rebuilt (${report.manifest.reason})` : "consistent"}`);
  lines.push(`snapshots: ${report.snapshots.count}${report.snapshots.newest ? ` | newest: ${report.snapshots.newest.id}` : ""}`);
  lines.push(`quarantined: ${report.quarantined.length}`);
  for (const entry of report.quarantined) lines.push(`  ${entry.path}: ${entry.code} (${entry.reason})`);
  if (report.lock) {
    const holder = report.lock.respected ? `respected ${report.lock.respected.host}:${report.lock.respected.pid}` : report.lock.broken ? `broke a ${report.lock.broken.reason} lock` : "no contention";
    lines.push(`lock: ${holder} | waited ${report.lock.waited_ms}ms`);
  }
  lines.push(
    `adapter health: coverage=${report.adapter_health.coverage_ppm ?? "n/a"} ppm | unmapped=${report.adapter_health.unmapped_tool_calls ?? "n/a"} | by_kind=${report.adapter_health.by_kind ? JSON.stringify(report.adapter_health.by_kind) : "n/a"}`,
  );
  lines.push(`health: ${report.degraded.length === 0 ? "ok" : report.degraded.join(", ")}`);
  return lines.join("\n");
}
