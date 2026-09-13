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
for internal errors under the normal, non-blocking integration contract. It reports the
failure as a first-class degraded or unavailable state, emits only safe local diagnostics,
and leaves the host agent's input and configuration alone. Time and resource budgets are
enforced; when a budget is exceeded, the hook stops and reports `degraded: budget-exceeded`.

The hook never guesses a session or repairs unknown transcript data. It records fewer facts,
or none, and marks the result degraded. Hook failures are observable through the pack header,
`doctor`, and local logs when enabled. An explicitly configured blocking mode, if supported
by a future integration, is an opt-in contract outside the default installer and must be
clearly surfaced; normal installed hooks remain non-blocking.

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
