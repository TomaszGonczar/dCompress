# ADR 005 — Reversible install

**Status:** Accepted
**Date:** 2026-09-13
**Deciders:** Operator
**Supersedes:** nothing
**Affects:** CONCEPT §§2, 6.2, 7.7, 11.1; DEVELOPMENT_PLAN P10; OG-55…OG-71

## Context

Installation edits an agent's configuration and may add command or hook entries. Those files
belong to the user and may contain unrelated settings or hooks. A tool that can install
itself but cannot restore the prior bytes is not trustworthy, especially when an agent
update or a partial write leaves the configuration unusable.

A parsed configuration is not enough for restoration: formatting, key order, comments, line
endings, and trailing bytes are all part of the user's file. The install boundary therefore
needs an exact backup and a narrowly identifiable block.

## Decision

Every file dcompact edits is backed up byte-for-byte before the first write. Managed entries
are rendered between dcompact-owned markers, and edits are limited to those marker blocks or
to a precisely declared insertion point in a parsed configuration. Writes are atomic and
verified after writing. `--dry-run` shows the proposed changes without touching a file.

`uninstall` is a first-class operation. It restores the recorded backups and removes
dcompact-owned state. It compares the current managed region with the recorded installed
region: if a user edited inside that region, uninstall refuses, preserves the file, and
reports the exact next step. Invalid JSON/TOML/configuration is likewise a refusal with the
file untouched. A repair operation may complete an interrupted install only after the
recorded state is checked.

## Consequences

- A clean install followed by uninstall restores every touched file byte-identically,
  including formatting that a parser would discard.
- User hooks outside the dcompact markers remain untouched, and the `/compact` command is
  never replaced.
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
