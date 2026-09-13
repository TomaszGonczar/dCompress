# ADR 003 — Facts, not transcripts

**Status:** Accepted
**Date:** 2026-09-13
**Deciders:** Operator
**Supersedes:** nothing
**Affects:** CONCEPT §§2–5, 8–10; SCHEMA §§2–4, 7–8; issues OG-55…OG-71

## Context

Agent transcripts already live in the agent's session store and can contain private
conversation, credentials accidentally pasted into a tool call, file contents, and model
reasoning. Copying them into a second store would increase retention, disk use, backup scope,
and the number of places a user must trust. It would also make a continuity snapshot a
transcript archive rather than a compact, auditable handoff.

dcompact needs only the durable signals required to resume work: atomic facts such as a file
change, command, error transition, user decision, todo state, or git state. A fact can point
back to the source line through the provenance fields defined by the schema without copying
the source line itself.

## Decision

dcompact stores extracted facts and the schema-defined counters, provenance references,
degraded states, and envelope metadata. It does not store transcript entries, full
conversation prose, assistant reasoning, or file contents. Facts may include bounded,
transcript-derived snippets for human-readable context; these are not a transcript archive.
Secret redaction is not implemented in the current Batch 1 code and is planned for P12 before
the v0.1 release. Until then, a snippet can contain sensitive text if the source record
supplies it. Full transcripts remain under the agent's control at their existing location, and
snapshots must be treated as potentially sensitive.

Every fact must be derived from transcript data or an explicit input. Provenance is a bounded
line-and-hash reference as specified by `SCHEMA.md`; it is not a transcript cache. Paths in a
payload follow the schema's normalization and exclusion rules, while machine-specific
locations belong in the envelope or other non-hashed metadata.

The default serialized snapshot budget is 512 KiB, and the context pack is independently
size-budgeted. A missing, rotated, or changed transcript makes provenance degraded; it does
not cause dcompact to retain a copy or silently preserve unsupported facts.

## Consequences

- Snapshots are small enough to inspect, back up, diff, and inject after compaction.
- The privacy and retention boundary is narrower: dcompact owns derived state, while the
  agent owns the conversation archive.
- `verify --provenance` requires the original transcript to still be readable. A snapshot
  can remain hash-valid while its evidence is reported as unbacked or drifted, as the schema
  requires.
- A user cannot reconstruct the full conversation from a snapshot. That is intentional; the
  tool is continuity for facts, not a transcript recovery product.

## Alternatives considered

- **Store every transcript:** rejected because it duplicates sensitive data, increases the
  attack and backup surface, and defeats bounded snapshots.
- **Store excerpts as evidence:** rejected as a transcript cache because excerpts can contain
  secrets and make provenance less mechanical. The bounded fact snippet is a separate,
  human-readable field; line number plus raw-line hash is sufficient for verification.
- **Store only a prose summary:** rejected because it loses atomic facts and has no reliable
  provenance; ADR 002 also rules out model-generated extraction.
