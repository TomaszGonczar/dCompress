# ADR 005 — Reversible install

**Status:** Accepted
**Date:** 2026-09-13
**Deciders:** Operator
**Supersedes:** nothing
**Affects:** CONCEPT §§2, 6.2, 7.6, 11.1; DEVELOPMENT_PLAN P10; OG-55…OG-71

## Context

Installation edits an agent's configuration and may add command or hook entries. Those files
belong to the user and may contain unrelated settings or hooks. A tool that can install
itself but cannot restore the prior bytes is not trustworthy, especially when an agent
update or a partial write leaves the configuration unusable.

A parsed configuration is not enough for restoration: formatting, key order, comments, line
endings, and trailing bytes are all part of the user's file. JSON has no comments, while
TOML and other comment-capable formats do; the install boundary therefore needs an exact
backup plus a format-specific, narrowly identifiable managed region.

## Decision

Every file dcompact edits is backed up byte-for-byte before the first write. A missing target
is recorded as an absent target (a tombstone), then created only when the adapter declares
that creation safe. For comment-capable formats, managed entries are rendered between
dcompact-owned markers. For JSON and TOML, where textual markers are not a portable managed
region, the adapter declares the owned object/key or table/array projection and records its
canonical installed value. Edits are limited to that managed region; unrelated content is
preserved. Writes are atomic, preserve file mode, refuse symlink targets, and are verified
after writing. `--dry-run` shows the proposed changes without touching a file.

`uninstall` is a first-class operation. It removes the managed region while preserving edits
outside it, then removes dcompact-owned state. It compares the current managed region with
the recorded installed region: if a user edited inside that region, uninstall refuses,
preserves the file, and reports the exact next step. For a target that was absent before
install, the generated file is removed only when it still contains exactly the recorded
managed content; any later edit causes the same refusal. Invalid JSON/TOML/configuration,
symlink targets, or an unverifiable managed region are refusals with the file untouched. The
original byte backup remains available for explicit recovery; it is not silently restored
over outside edits. A repair operation may complete an interrupted install only after the
recorded state is checked.

## Consequences

- A clean install followed by uninstall restores every touched file byte-identically,
  including formatting that a parser would discard. If a user edits outside the managed
  region after install, uninstall preserves that edit while removing only dcompact's region;
  if the managed region changed, it refuses instead of guessing.
- User hooks outside the dcompact markers (or outside the format-specific owned fields) remain
  untouched, and the `/compact` command is never replaced.
- Backups consume storage and must be retained until the install state is safely removed;
  cleanup is explicit and observable rather than silent.
- Conflict refusal can require a manual merge, but it prevents dcompact from destroying a
  user's later edit. Forceful recovery, if provided, remains an explicit user action after
  a backup and warning.

## Alternatives considered

- **Rewrite the complete parsed config:** rejected because it loses formatting and risks
  unrelated settings.
- **Append an untracked shell snippet:** rejected because it is hard to detect, uninstall,
  or distinguish from a user's change.
- **Restore by inverse parsing:** rejected because semantic equivalence is weaker than the
  byte-identical restoration guarantee.
