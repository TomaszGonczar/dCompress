import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Checkpoint/transcript binding, shared by the Stage-0 manifest and the
 * medium-series controller.
 *
 * `src/core/hash.ts` hashes a transcript line by its exact bytes **including the
 * terminator**, so a checkpoint evidence entry for physical line N equals
 * `sha256(<raw bytes of line N, newline included>)`. Binding is therefore
 * recomputed from the retained transcript at `envelope.transcript_bytes` rather
 * than assumed from a hook-entry length: the live transcript can grow between
 * hook entry and the store read.
 */

/** SHA-256 of exactly these bytes, in dcompact's `sha256:<hex>` form. */
export function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Split bytes into physical lines, each keeping its terminator when it has one. */
export function physicalLines(bytes) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    lines.push(bytes.subarray(start, index + 1));
    start = index + 1;
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  return lines;
}

/** The retained prefix and its line count, counted the way the envelope counts. */
export function retainedPrefix(bytes, transcriptBytes) {
  const prefix = bytes.subarray(0, transcriptBytes);
  const newlines = prefix.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0);
  const lines = newlines + (prefix.length > 0 && prefix.at(-1) !== 0x0a ? 1 : 0);
  return {
    retainedPrefixBytes: prefix.byteLength,
    retainedPrefixLines: lines,
    retainedPrefixSha256: digest(prefix),
    prefixEndsAtLineBoundary: prefix.length === 0 || prefix.at(-1) === 0x0a,
  };
}

/**
 * Recompute every C-binding value that is recomputable from the retained
 * transcript alone.
 *
 * `checkpointHashShapeValid` is a **shape** check on the recorded digest, not a
 * recomputation: it only asserts the string looks like `sha256:<64 hex>`. Real
 * hash verification happens when dcompact's `restore` re-derives the payload
 * hash through `payloadHash` and refuses a mismatch; the caller records that
 * outcome separately as `checkpointHashRecomputedByRestore`. Keeping the two
 * apart matters because a shape check can never refute a tampered payload.
 */
export function checkpointBinding({ transcriptPath, checkpoint }) {
  const bytes = readFileSync(transcriptPath);
  const prefix = retainedPrefix(bytes, checkpoint.envelope.transcript_bytes);
  // Evidence is hashed from the envelope-bounded prefix only. Slicing the whole
  // transcript would let a line written *after* the checkpoint satisfy evidence
  // for that checkpoint, which is exactly the staleness the binding exists to
  // rule out.
  const lines = physicalLines(bytes.subarray(0, checkpoint.envelope.transcript_bytes));

  let required = 0;
  let matched = 0;
  const mismatched = [];
  const outOfRange = [];
  for (const fact of checkpoint.payload?.facts ?? []) {
    for (const entry of fact.evidence ?? []) {
      required += 1;
      const withinPrefix = Number.isInteger(entry.line) && entry.line >= 1 && entry.line <= lines.length;
      if (!withinPrefix) {
        // A line number beyond the envelope boundary is not evidence from this
        // checkpoint, even if the later transcript happens to match it.
        outOfRange.push(entry.line);
        mismatched.push(entry.line);
        continue;
      }
      const raw = lines[entry.line - 1];
      if (raw !== undefined && digest(raw) === entry.sha256) matched += 1;
      else mismatched.push(entry.line);
    }
  }

  const normalised = transcriptPath.replaceAll("\\", "/");
  return {
    ...prefix,
    evidenceLineCount: lines.length,
    envelopeBytesMatch: checkpoint.envelope.transcript_bytes === prefix.retainedPrefixBytes,
    envelopeLinesMatch: checkpoint.envelope.transcript_lines === prefix.retainedPrefixLines,
    checkpointEvidenceEntriesMatched: matched,
    checkpointEvidenceEntriesRequired: required,
    checkpointEvidenceEntriesMismatched: mismatched,
    checkpointEvidenceEntriesOutOfPrefix: outOfRange,
    evidenceFullyBound: required > 0 && matched === required && prefix.prefixEndsAtLineBoundary
      && outOfRange.length === 0,
    checkpointHashShapeValid: /^sha256:[0-9a-f]{64}$/.test(String(checkpoint.envelope.hash)),
    previousHashShapeValid: checkpoint.envelope.previous_hash === null
      || /^sha256:[0-9a-f]{64}$/.test(String(checkpoint.envelope.previous_hash)),
    pathClassExcludesFixtureAndReplay: !/test\/fixtures|docs\/demo|\.vectors-build/.test(normalised),
  };
}

/**
 * Bind a checkpoint to the transcript, then prove the checkpoint itself is
 * intact by running dcompact's own `restore`, which re-derives the payload hash
 * and refuses a mismatch. Returns the binding with the recomputation outcome
 * recorded, so the emitted artifact carries real verification rather than a
 * regex dressed as one.
 */
export function restoreVerifiedBinding({ transcriptPath, checkpoint, restore }) {
  const binding = checkpointBinding({ transcriptPath, checkpoint });
  const outcome = restore();
  const recomputed = outcome.status === 0 && typeof outcome.pack === "string" && outcome.pack.includes("[dcompress:");
  return {
    ...binding,
    checkpointHashRecomputedByRestore: recomputed,
    checkpointHashRecomputeRefusalCode: recomputed ? null : outcome.refusalCode,
    checkpointHashRecomputeDetail: recomputed ? null : outcome.detail,
  };
}
