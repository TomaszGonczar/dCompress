# ADR 006 — A hook never fails its host

**Status:** Accepted
**Date:** 2026-09-13
**Deciders:** Operator
**Supersedes:** nothing
**Affects:** AGENTS.md invariant 6; CONCEPT §§6.2, 7.7, 8, 11.1–11.3; DEVELOPMENT_PLAN D8; OG-55…OG-71

## Context

dcompact runs at lifecycle boundaries owned by another agent. A malformed transcript, a
rotated file, a full disk, a changed hook payload, a lock timeout, or a dcompact bug must not
prevent the user from continuing their coding session. Recording continuity is valuable, but
the availability of the host agent is more important.

Returning a non-zero status from an installed hook makes an optional feature a hard
dependency. It also encourages clever recovery in the hook process, where a wrong snapshot
is worse than no snapshot.

## Decision

Every dcompact hook entry point wraps its internal work in a failure boundary and exits `0`
for internal errors. It reports the result using only the following finite hook outcomes:
`ok`; `degraded: schema-drift`, `degraded: extraction-empty`,
`degraded: provenance-broken`, `degraded: budget-exceeded`, `degraded: internal-error`, or
`degraded: no-pre-compaction-hook`;
`unavailable: agent-not-installed` or `unavailable:store`; and `untrusted:
hook-pending-review`. The two hook-only outcomes `unavailable:store` and
`internal-error` (displayed as `degraded: internal-error`) are raw `DegradedState` values in
`src/core/types.ts`; they are surfaced through hook output, `doctor`, or diagnostics and must
not be used to claim that an envelope was written when persistence failed. The hook emits only
safe local diagnostics and leaves the host agent's input and configuration alone. Time and
resource budgets are enforced; when a budget is exceeded, the hook stops and reports
`degraded: budget-exceeded`.

The hook never guesses a session or repairs unknown transcript data. Malformed or changed hook
or transcript input, including unknown transcript shape, maps to `degraded: schema-drift`; an
empty extraction from a non-empty recognized transcript
maps to `degraded: extraction-empty`; an unreadable or rotated provenance source maps to
`degraded: provenance-broken`; an absent agent maps to `unavailable: agent-not-installed`;
an untrusted installed hook maps to `untrusted: hook-pending-review`; lack of a pre-compaction
hook maps to `degraded: no-pre-compaction-hook`; and a lock timeout or wall-clock exhaustion
maps to `degraded: budget-exceeded`. A disk-full or other store-write
failure maps to `unavailable:store`: the hook reports it through its output, `doctor`, or a
safe local diagnostic and does not claim that an envelope was persisted. An unexpected dcompact
bug maps to `degraded: internal-error`. An unmapped tool is not a hook failure: it is counted
in the payload and does not itself change the state. Otherwise a completed hook is `ok`. There
is no blocking mode; installed hooks always return `0`, even when they emit a degraded or
unavailable result.

## Consequences

- The agent remains usable during dcompact outages and integration drift.
- A missed snapshot is visible rather than silently presented as complete continuity.
- Hook code must be small, bounded, defensive, and independently fault-tested.
- Users may occasionally get no fresh snapshot after an error; this is safer than a partial
  or wrong snapshot injected with normal confidence.

## Alternatives considered

- **Fail the host on snapshot failure:** rejected because it turns continuity into an
  availability risk.
- **Swallow errors silently:** rejected because users and maintainers need degraded states,
  counters, and diagnostics to distinguish no work from failed work.
- **Retry indefinitely in the hook:** rejected because it violates the wall-clock budget and
  can itself stall the host agent.
