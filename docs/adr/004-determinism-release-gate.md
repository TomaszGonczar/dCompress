# ADR 004 — Determinism is a release gate

**Status:** Accepted
**Date:** 2026-09-13
**Deciders:** Operator
**Supersedes:** nothing
**Affects:** CONCEPT §§2, 5, 11.4; SCHEMA §§1, 5–6; DEVELOPMENT_PLAN Wave 1; OG-55…OG-71

## Context

The central promise is that the same transcript bytes and the same extraction inputs produce
the same canonical snapshot payload bytes and the same payload hash on any supported machine.
Without that property, `verify`
cannot distinguish an input change from a sampler, clock, locale, host, or implementation
accident. An unverifiable snapshot is just another summary, which is not a useful product
boundary for dcompact.

Nondeterminism can enter through global environment reads, wall-clock values, host paths,
unordered traversal, locale-sensitive operations, unstable fact merging, or a change to
canonical JSON. It is cheaper to catch these before adapters and storage hide the cause.

## Decision

Determinism is a release gate, not a quality goal to revisit after shipping. A release is
blocked when the determinism suite is not green on all supported CI platforms or when a
fixture produces a different canonical payload or hash under the prescribed perturbations.

The suite must exercise **every fixture** with changed `TZ`, `LANG`, `LC_ALL`, `HOME`, cwd,
clock, hostname, and OS inputs, while holding transcript bytes and all extraction inputs
constant. It must also test shuffled event order where merging is intended to be
order-independent. Nondeterministic inputs are injected explicitly; they are not read from
global state in the core. A deliberate nondeterminism is periodically introduced to prove
the suite can fail, then reverted.

Extraction inputs include the repo root, `path_base`, adapter and extractor configuration,
extractor version, canonicalization version, and any explicit git state included in the
payload. Environment perturbation must not silently change any of these inputs.

The hash remains exactly `sha256(UTF-8(canonical(payload)))`. Envelope values such as clock,
host, adapter version, and absolute locations stay outside the hashed payload. Any change to
canonicalization is a schema event and must bump the canonicalization version; an extractor
change bumps its own version and is reviewed for provenance impact.

## Consequences

- CI failures are release-blocking evidence, not flaky warnings to waive.
- Core APIs need injected clock, paths, and other environmental inputs, which makes them
  slightly more explicit but straightforward to test.
- Schema and extractor versioning become part of change management.
- A rule that would be convenient but cannot be made deterministic is excluded or degraded;
  the product prefers a missing fact to a fact that changes between runs.

## Alternatives considered

- **Best-effort determinism:** rejected because users cannot trust verification when a
  mismatch may be normal.
- **Hash the complete snapshot file:** rejected because pretty-printing and envelope clocks
  would make harmless metadata changes invalidate the payload hash.
- **Normalize only on the developer's machine:** rejected because the claim is explicitly
  cross-machine and cross-environment.
