/**
 * Read-only verification queries over a stored snapshot (CONCEPT §6.2, SCHEMA §7).
 *
 * Nothing here writes: the payload-hash check re-derives `payloadHash(payload)` and compares
 * it with the value the caller already has (`readSnapshot` already refused anything that
 * disagreed, by quarantining it — this module states the comparison explicitly, for a command
 * whose whole job is to report it). The provenance check re-reads the transcript an envelope
 * names and never mutates it.
 *
 * A transcript that is absent, unreadable, or has drifted must never be reported as backing a
 * fact anyway (AGENTS "never guess"; SCHEMA §7): a fact is `unbacked` when the transcript could
 * not be consulted at all, `drifted` when a named line exists but no longer hashes to the
 * recorded evidence, and `backed` only when at least one evidence line still matches.
 */

import { readFileSync } from "node:fs";

import { lineHash, payloadHash, splitPhysicalLines } from "../core/hash.js";
import type { Fact, Snapshot } from "../core/types.js";

export interface PayloadHashCheck {
  readonly ok: boolean;
  readonly expected: string;
  readonly computed: string;
}

/** Recompute `payloadHash(payload)` and compare it with the envelope's recorded hash. */
export function checkPayloadHash(snapshot: Snapshot): PayloadHashCheck {
  const computed = payloadHash(snapshot.payload);
  return { ok: computed === snapshot.envelope.hash, expected: snapshot.envelope.hash, computed };
}

export type ProvenanceState = "backed" | "drifted" | "unbacked";

export interface FactProvenance {
  readonly kind: Fact["kind"];
  readonly key: string;
  readonly state: ProvenanceState;
}

export interface ProvenanceReport {
  readonly transcriptPath: string | null;
  readonly transcriptReadable: boolean;
  readonly facts: readonly FactProvenance[];
  readonly counts: { readonly backed: number; readonly drifted: number; readonly unbacked: number };
}

function readTranscriptLines(path: string): readonly Uint8Array[] | null {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    // Absent, unreadable, or rotated away: every fact below is unbacked, never guessed at.
    return null;
  }
  return splitPhysicalLines(bytes);
}

/**
 * One fact's state against the lines actually on disk: `backed` if any evidence entry's line
 * still hashes to what was recorded, `drifted` if none do but at least one named line exists
 * (the transcript changed under it), `unbacked` otherwise (SCHEMA §7).
 */
function factProvenance(fact: Fact, lines: readonly Uint8Array[] | null): ProvenanceState {
  if (lines === null) return "unbacked";
  let sawDrift = false;
  for (const evidence of fact.evidence) {
    const line = lines[evidence.line - 1];
    if (line === undefined) continue;
    if (lineHash(line) === evidence.sha256) return "backed";
    sawDrift = true;
  }
  return sawDrift ? "drifted" : "unbacked";
}

/** Re-read `envelope.transcript_path` and check every fact's evidence against it. */
export function checkProvenance(snapshot: Snapshot): ProvenanceReport {
  const path = snapshot.envelope.transcript_path;
  const lines = path === null ? null : readTranscriptLines(path);
  const counts = { backed: 0, drifted: 0, unbacked: 0 };
  const facts = snapshot.payload.facts.map((fact): FactProvenance => {
    const state = factProvenance(fact, lines);
    counts[state] += 1;
    return { kind: fact.kind, key: fact.key, state };
  });
  return { transcriptPath: path, transcriptReadable: lines !== null, facts, counts };
}
