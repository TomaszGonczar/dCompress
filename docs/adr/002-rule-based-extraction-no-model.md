# ADR 002 — Rule-based extraction, no model

**Status:** Accepted
**Date:** 2026-09-13
**Deciders:** Operator
**Supersedes:** nothing
**Affects:** CONCEPT §§2–5, 9; SCHEMA §§3–7; issues OG-55…OG-71

## Context

dcompact exists because an agent's compaction summary is lossy and unverifiable. Sending
the transcript to another model would reproduce the problem inside dcompact: output could
vary with sampling, model version, provider availability, or an undocumented prompt. It
would also put the most sensitive input in another inference path.

The useful signals are already present in the structured transcript. Tool calls, their
arguments and results, user-authored decisions, todo updates, and explicit git observations
can be mapped to a bounded fact vocabulary. The mapping can be audited against transcript
line evidence and tested with golden fixtures.

## Decision

The extraction path is rule-based and contains no model call. Each extractor is a pure
function from normalized transcript events and explicit configuration to facts. Adapters may
locate and map agent-specific records, but they do not interpret prose or add model-derived
facts.

An **unknown transcript shape** is a record the adapter cannot normalize according to its
declared schema; it produces fewer facts and the valid `degraded: schema-drift` state (or
`degraded: extraction-empty` when a non-empty, otherwise recognized transcript yields no
facts). An **unmapped tool** is different: the record shape is recognized, but the adapter's
tool-to-kind map has no decision for that tool. It increments `counters.unmapped_tool_calls`
and reduces `coverage_ppm`, while leaving the degraded state unchanged (including the
`degraded: []` unknown-tool fixture). Neither case is repaired by asking a model to guess.

The resulting facts are canonicalized and hashed according to `SCHEMA.md`. A model may be a
caller of an exposed tool, but it is not a dependency of extraction, canonicalization,
verification, storage, or rendering.

## Consequences

- The same input can be replayed, diffed, verified, and covered by fixtures without a
  provider, account, network, or sampling setting.
- Rule changes are visible code and versioned extractor changes rather than hidden prompt or
  model changes.
- The fact vocabulary is deliberately narrower than a prose summary. Ambiguous content is
  omitted and marked degraded rather than promoted to a plausible-looking fact.
- Maintaining adapters and lexicons is ongoing work, and rules will miss signals that are
  not represented in the known transcript shapes. That is an accepted cost of verifiability.

## Alternatives considered

- **LLM summary:** rejected because it is nondeterministic, unverifiable, network-sensitive,
  and duplicates the agent behaviour dcompact is intended to complement.
- **Hybrid extraction with model fallback:** rejected because a fallback would make the
  extraction contract and hashes depend on model availability and would turn an unknown
  shape into an untraceable assertion.
- **Copying the transcript into a second system for later interpretation:** rejected here;
  ADR 003 records why dcompact stores derived facts instead.
