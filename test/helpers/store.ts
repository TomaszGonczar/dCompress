import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { payloadHash } from "../../src/core/hash.js";
import type { AdapterId, DegradedState, Envelope, Fact, Payload, Snapshot } from "../../src/core/types.js";
import { readSnapshot } from "../../src/store/snapshot.js";
import type { ReadSnapshotOptions } from "../../src/store/snapshot.js";
import { StoreRefusal } from "../../src/store/types.js";
import type { SnapshotReadQuarantined } from "../../src/store/types.js";

/** Disposable store roots under the system temp directory; never the user's real store. */
export function tempRoots(): { readonly next: () => string; readonly clean: () => void } {
  const roots: string[] = [];
  return {
    next: () => {
      const root = mkdtempSync(join(tmpdir(), "dcompact-og58-"));
      roots.push(root);
      return root;
    },
    clean: () => {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface SnapshotFixtureOptions {
  readonly createdAt?: string;
  readonly text?: string;
  readonly sessionId?: string;
  readonly adapter?: AdapterId;
  readonly degraded?: DegradedState[];
}

/** One `decision.stated` fact, hashed exactly as the core would hash it. */
export function makeSnapshot(options: SnapshotFixtureOptions = {}): Snapshot {
  const text = options.text ?? "use bounded retry, not infinite backoff";
  const fact: Fact = {
    kind: "decision.stated",
    key: text,
    at: { entry: 0, ts: null },
    attrs: { cue: "use" },
    evidence: [{ line: 1, sha256: `sha256:${"0".repeat(64)}` }],
    snippet: text,
    unbacked: false,
  };
  const payload: Payload = {
    facts: [fact],
    counters: {
      facts: 1,
      by_kind: { "decision.stated": 1 },
      source_entries: 1,
      source_tool_calls: 0,
      unmapped_tool_calls: 0,
      coverage_ppm: 0,
      external_path_count: 0,
    },
    git: null,
    plan: null,
    path_base: "cwd",
    version: 1,
  };
  const envelope: Envelope = {
    schema_version: "1.0.0",
    canonicalization: 3,
    extractor_version: "0.1.0",
    created_at: options.createdAt ?? "2026-09-13T08:41:09Z",
    adapter: options.adapter ?? "claude",
    adapter_version: null,
    session_id: options.sessionId ?? "session-1",
    transcript_path: null,
    transcript_bytes: 0,
    transcript_lines: 0,
    transcript_mtime: null,
    host: { os: "darwin", arch: "arm64", node: "20.0.0" },
    store: { cwd: "/tmp/repo", repo_root: null },
    degraded: options.degraded ?? [],
    previous_hash: null,
    duration_ms: 0,
    hash: payloadHash(payload),
  };
  return { envelope, payload };
}

/** Run an action that must refuse, and hand back the refusal so its code can be asserted. */
export function refusalFrom(action: () => unknown): StoreRefusal {
  try {
    action();
  } catch (error) {
    if (error instanceof StoreRefusal) return error;
    throw error;
  }
  throw new Error("expected the action to refuse, but it returned");
}

/** Read a snapshot that must be usable; a quarantine is a failure here. */
export function usableSnapshot(path: string, options: ReadSnapshotOptions = {}): Snapshot {
  const result = readSnapshot(path, options);
  if (result.status !== "ok") throw new Error(`expected a usable snapshot at ${path}, got ${result.code}: ${result.reason}`);
  return result.snapshot;
}

/** Read a snapshot that must be quarantined; a usable read is a failure here. */
export function quarantinedSnapshot(path: string): SnapshotReadQuarantined {
  const result = readSnapshot(path);
  if (result.status !== "quarantined") throw new Error(`expected ${path} to be quarantined, got a usable snapshot`);
  return result;
}