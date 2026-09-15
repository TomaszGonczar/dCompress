# ADR 008 — XDG storage on every platform

**Status:** Accepted
**Date:** 2026-09-13
**Deciders:** Operator
**Supersedes:** CONCEPT §13.1 (open question)
**Affects:** CONCEPT §§6.3, 10, 13; SCHEMA §§2, 8; DEVELOPMENT_PLAN P0 and P3; OG-55…OG-71

## Context

dcompress needs durable local state for snapshots, manifests, locks, retention metadata,
optional logs, adapter definitions, and install backups. The tool must not put host-specific
locations into a hashed payload, and users need to know where to inspect, back up, or remove
its state.

Platform-native defaults would mean one documented location on Linux, another on macOS, and
another on Windows. That is familiar to each platform but makes support, scripts, backup
instructions, fixtures, and uninstall reasoning needlessly divergent. The project already
describes an XDG-style layout and explicitly leaves the macOS choice open.

## Decision

dcompress uses XDG-style locations on every platform. By default:

```text
data:   ${XDG_DATA_HOME:-$HOME/.local/share}/dcompress/
config: ${XDG_CONFIG_HOME:-$HOME/.config}/dcompress/
```

The data root contains session snapshots, manifests, locks, `config.json`, and optional logs;
the config root contains adapter definitions and install backups, as described in
`CONCEPT.md`. These same defaults apply on macOS and Windows; platform-native application
directories are not used. On Windows, the same XDG variables are honoured when set, with
`$HOME/.local/share` and `$HOME/.config` as the deterministic fallback rather than a
platform-specific split.

`DCOMPRESS_HOME` is the explicit override for all dcompress-owned state. When set, it is the
single state root containing the equivalent `sessions/`, `config.json`, `logs/`, `adapters/`,
and `backups/` subtrees, including all backups and logs; XDG data and config variables are
not consulted. This makes tests, CI, portable installations, and deliberate backup/removal
operations self-contained. The override is read only at the I/O boundary; it never reaches a
hashed payload. An unset or invalid home path is an operational error, not a reason to guess
another location.

All state directories are private to the invoking user (mode `0700` where POSIX permissions
apply), and state files are owner-readable/writable only (mode `0600` where supported;
equivalent owner-only ACLs on Windows). dcompress refuses a symlink in place of the state root
or any state directory it creates; it never follows a link for storage. Failure to create or
enforce the private state boundary is an operational error, not a fallback condition.

Project-local `.dcompress/` state is implemented only when the user explicitly invokes
`dcompress init`; it is not the default store. It uses the same schema and private-permission
rules, and does not move, replace, or alter the user-scoped store or canonicalization inputs.

## Consequences

- Documentation, scripts, fixture tests, and support instructions have one default layout
  across Linux, macOS, and Windows.
- `DCOMPRESS_HOME` gives CI and operators a clean, relocatable state root without changing
  the production default or the snapshot hash.
- Private permissions and symlink refusal reduce accidental disclosure and link traversal;
  installations on platforms without POSIX mode bits use the corresponding owner-only ACL
  and still refuse a symlinked state root.
- The defaults are less native-looking on macOS and Windows, and users who expect those
  platforms' conventional application directories may need an explanation. Predictability
  and one backup/removal model are accepted as the greater benefit for this local tool.
- XDG environment variables and the override are process configuration only. They are never
  used as fact inputs, and absolute paths remain envelope or operational metadata under the
  schema.

## Alternatives considered

- **Platform-native application directories:** rejected because they create a platform split
  and make the documented one-path backup and removal story harder. This is the open question
  closed by this ADR.
- **Only `$HOME/.dcompress`:** rejected because it conflates data and configuration and does
  not follow the existing XDG layout.
- **Project-local storage by default:** rejected because every checkout would duplicate
  snapshots and backups; it remains an explicit `init` option.
- **An implicit “find a writable directory” fallback:** rejected because it hides placement
  mistakes and would make state location surprising and harder to audit.
