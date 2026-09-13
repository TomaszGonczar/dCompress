# ADR 008 — XDG storage on every platform

**Status:** Accepted
**Date:** 2026-09-13
**Deciders:** Operator
**Supersedes:** CONCEPT §13.1 (open question)
**Affects:** CONCEPT §§6.2, 10, 13; SCHEMA §§2, 8; DEVELOPMENT_PLAN P0 and P3; OG-55…OG-71

## Context

dcompact needs durable local state for snapshots, manifests, locks, retention metadata,
optional logs, adapter definitions, and install backups. The tool must not put host-specific
locations into a hashed payload, and users need to know where to inspect, back up, or remove
its state.

Platform-native defaults would mean one documented location on Linux, another on macOS, and
another on Windows. That is familiar to each platform but makes support, scripts, backup
instructions, fixtures, and uninstall reasoning needlessly divergent. The project already
describes an XDG-style layout and explicitly leaves the macOS choice open.

## Decision

dcompact uses XDG-style locations on every platform. By default:

```text
data:   ${XDG_DATA_HOME:-$HOME/.local/share}/dcompact/
config: ${XDG_CONFIG_HOME:-$HOME/.config}/dcompact/
```

The data root contains session snapshots, manifests, locks, `config.json`, and optional logs;
the config root contains adapter definitions and install backups, as described in
`CONCEPT.md`. macOS uses these same defaults; it does not silently redirect to
`~/Library/Application Support`. On Windows, the same XDG variables are honoured when set,
with `$HOME/.local/share` and `$HOME/.config` as the deterministic fallback rather than a
platform-specific split.

`DCOMPACT_HOME` is the explicit override for all dcompact-owned state. When set, it is the
single state root containing the equivalent `sessions/`, `config.json`, `logs/`, `adapters/`,
and `backups/` subtrees, including all backups and logs; XDG data and config variables are
not consulted. This makes tests, CI, portable installations, and deliberate backup/removal
operations self-contained. The override is read only at the I/O boundary; it never reaches a
hashed payload. An unset or invalid home path is an operational error, not a reason to guess
another location.

Project-local `.dcompact/` state exists only when the user explicitly invokes `dcompact init`
and is not the default store. A project-local store does not change the location of the
user-scoped store or the canonicalization rules.

## Consequences

- Documentation, scripts, fixture tests, and support instructions have one default layout
  across Linux, macOS, and Windows.
- `DCOMPACT_HOME` gives CI and operators a clean, relocatable state root without changing
  the production default or the snapshot hash.
- The defaults are less native-looking on macOS and Windows, and users who expect those
  platforms' conventional application directories may need an explanation. Predictability
  and one backup/removal model are accepted as the greater benefit for this local tool.
- XDG environment variables and the override are process configuration only. They are never
  used as fact inputs, and absolute paths remain envelope or operational metadata under the
  schema.

## Alternatives considered

- **macOS `~/Library/Application Support` plus Windows `%LOCALAPPDATA%`/`%APPDATA%`:**
  rejected because it creates a platform split and makes the documented one-path backup and
  removal story harder. This is the open question closed by this ADR.
- **Only `$HOME/.dcompact`:** rejected because it conflates data and configuration and does
  not follow the existing XDG layout.
- **Project-local storage by default:** rejected because every checkout would duplicate
  snapshots and backups; it remains an explicit `init` option.
- **An implicit “find a writable directory” fallback:** rejected because it hides placement
  mistakes and would make state location surprising and harder to audit.
