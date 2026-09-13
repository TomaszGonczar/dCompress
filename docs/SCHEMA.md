# dcompact — Snapshot schema and canonicalization

Normative. If code and this document disagree, code is wrong.

`canonicalization: 1` — the version below. Any behavioural change to the rules in §3–§6
bumps this value and is a breaking schema event.

## 1. Why this document exists

`dcompact` claims determinism: the same transcript bytes must produce the same snapshot
bytes, on any machine, at any time. That claim is only true if "the same bytes" is defined
mechanically. This document is that definition.

The single rule behind all the detail:

> **`payload` contains only values derived from the transcript and from explicit inputs.
> Everything else — clock, host, absolute paths, versions, provenance — lives in
> `envelope` and is excluded from the hash.**

## 2. File shape

One file per snapshot: `snapshots/<utc-iso>-<hash12>.json`.

```jsonc
{
  "envelope": {
    "schema_version": "1.0.0",
    "canonicalization": 1,
    "extractor_version": "0.1.0",
    "created_at": "2026-09-13T08:41:09Z",     // wall clock, UTC, seconds precision
    "adapter": "claude",
    "adapter_version": "2.1.104",              // reported by the agent, or null
    "session_id": "099e41bf-…",
    "transcript_path": "~/.claude/projects/…/099e41bf….jsonl",
    "transcript_bytes": 184223,
    "transcript_lines": 1204,
    "transcript_mtime": "2026-09-13T08:40:58Z",
    "host": { "os": "darwin", "arch": "arm64", "node": "22.11.0" },
    "store": { "cwd": "/Users/alice/repo", "repo_root": "/Users/alice/repo" },
    "degraded": [],
    "previous_hash": "…" | null,
    "duration_ms": 143,
    "hash": "sha256:6bd0…"                     // hash of canonical(payload)
  },
  "payload": { /* §3 — hashed, fully canonical */ }
}
```

Notes:

- `envelope.hash` is the hash of the *payload only*. Hashing the envelope is impossible
  (it contains the hash) and pointless (it contains the clock).
- `snapshot_id` is `<created_at>\|<hash>`; the display form is the short hash.
- Absolute paths appear only in `envelope`. Anything path-shaped inside `payload` is
  repo-relative (§5.2).
- `degraded` is an array of state tokens from CONCEPT §11.2, sorted and deduplicated.

## 3. Payload

```jsonc
{
  "facts": [ /* §4, sorted, deduplicated */ ],
  "counters": {
    "facts": 43,
    "by_kind": { "file.modified": 7, "cmd.run": 12, "error.raised": 3, … },  // keys sorted
    "source_entries": 1204,
    "source_tool_calls": 311,
    "unmapped_tool_calls": 4,
    "coverage": 0.9871                     // (source_tool_calls − unmapped) / source_tool_calls
  },
  "git": {                                  // null when not a repo or git unavailable
    "head": "4f2a1c9d…",                    // full sha, or "unborn"
    "branch": "main",
    "dirty": true,
    "status_hash": "sha256:9a1c…",          // hash of canonicalized porcelain output
    "diff_stat": { "files": 7, "added": 214, "removed": 38 }
  },
  "plan": { "todos": 5, "done": 2, "items": [ "…" ] } | null,
  "version": 1
}
```

`counters` is derived, not authoritative — it exists so a human can eyeball coverage, and
so `doctor` can detect an extraction regression.

## 4. Facts

One fact = one atomic, transcript-derived statement.

```jsonc
{
  "kind": "file.modified",
  "key": "src/dispatch.ts",             // the fact's identity within its kind
  "at": { "entry": 842, "ts": "2026-09-13T08:12:04Z" },
  "attrs": { "edits": 3, "tools": ["Edit", "Edit", "Write"] },
  "evidence": [
    { "path": "~/.claude/projects/…/x.jsonl", "line": 901, "sha256": "…" }
  ],
  "snippet": "Edit src/dispatch.ts — replace retry loop",
  "unbacked": false
}
```

### 4.1 Kind vocabulary (v1)

| Kind | `key` is | Required `attrs` | Ordering label |
|---|---|---|---|
| `file.modified` | repo-relative path | `edits`, `tools[]` | 30 |
| `file.read` | repo-relative path | `reads` | 60 |
| `file.created` | repo-relative path | — | 20 |
| `file.deleted` | repo-relative path | — | 20 |
| `cmd.run` | normalized command text | `runs`, `failed` | 50 |
| `cmd.failed` | normalized command text | `runs`, `last_error_class` | 40 |
| `error.raised` | error signature | `count`, `class` | 10 |
| `error.fixed` | error signature | `count`, `fixed_by` | 15 |
| `decision.stated` | normalized decision text (≤200 chars) | `cue` | 5 |
| `todo.state` | `open` \| `done` \| `item:<n>` | `text` | 70 |
| `plan.state` | `plan` | `todos`, `done` | 70 |
| `git.state` | `head` \| `status` \| `diff` | — | 80 |
| `note` | slug | `text` | 90 |

An unknown kind is a schema violation, not a forward-compatible extension: adding a kind
bumps `version` in the payload.

### 4.2 Sorting (must be total and stable)

Facts sort by the tuple:

1. `priority` (the Ordering label above) ascending
2. `kind` ascending, code-point
3. `key` ascending, code-point
4. `at.entry` ascending, numeric

Two facts identical on all four fields are duplicates by definition and are merged
(§4.3). Ties beyond this tuple cannot occur; if they do, the extractor is nondeterministic
and the build fails.

### 4.3 Merging

Two facts with the same `(kind, key)` merge:

- `attrs` numeric fields sum (`edits`, `reads`, `runs`, `count`).
- `attrs` array fields union, then sort, then dedupe (`tools`).
- `attrs` scalar fields: keep the value from the **later** `at.entry`.
- `evidence` concatenates, then sorts by `(line, sha256)`, then dedupes; capped at 5,
  keeping the **first** 5 after sort.
- `snippet` keeps the **earliest** non-empty value (the first occurrence is the most
  faithful description of the fact's origin).
- `at` keeps the **earliest** entry.

Merging is applied repeatedly until the fact list is a fixed point. This guarantees that
feeding the same facts in a different input order yields the same output.

## 5. Canonicalization rules

### 5.1 JSON encoding

- Object keys sorted ascending by Unicode code point.
- No insignificant whitespace; `,` and `:` separators only.
- Strings: JSON-escaped per RFC 8259 `"` and `\` and control characters; all other
  characters emitted literally as UTF-8. No `\uXXXX` for non-ASCII.
- Unicode normalization form **NFC** applied to every string before escaping.
- Numbers: integers only in the `payload` (no floats in v1). Encoded without exponent, no
  leading `+`, no leading zeros.
- `null` allowed; `undefined` prohibited.
- Empty object `{}` and empty array `[]` are emitted as such, never omitted.
- Arrays preserve the order the payload defines (they are already sorted by §4.2 or by the
  set rule in §5.3).

### 5.2 Paths

Rules, applied in order:

1. Paths are compared and stored **repo-relative** when inside the repo root
   (`store.repo_root`, resolved once at snapshot time).
2. Separator is `/` on every platform.
3. No leading `./`; no trailing `/`; no `.` or `..` segments after normalization.
4. Case is preserved as written. Case-insensitive filesystems do **not** cause case folding
   — folding would make macOS and Linux disagree.
5. Paths outside the repo root are **excluded from `payload`** and counted in
   `counters` under an `external_paths` key (in the envelope, not the payload).
6. Symlinks are not resolved. The literal path the tool was given is the fact's key.
7. If `store.repo_root` is unknown (not a repo), paths are stored relative to
   `store.cwd`, and the payload records `"path_base": "cwd"` so the meaning is explicit.
   `path_base` values: `"repo"` (default) or `"cwd"`.

### 5.3 Sets

These arrays are sets and are sorted + deduped before hashing:

- `payload.facts[].attrs.tools[]` — sorted code-point, deduped
- `payload.facts[].evidence[]` — sorted by `(line, sha256)`, deduped
- `payload.facts[]` — sorted by §4.2
- `envelope.degraded[]` — sorted, deduped (not hashed, but still canonical for diffing)
- `counters.by_kind` — keys sorted

Nothing else is treated as a set. In particular, `plan.items` and `cmd` ordering keep their
semantic order.

### 5.4 Normalized command text

`cmd.run` / `cmd.failed` keys normalize:

1. Trim leading/trailing whitespace.
2. Collapse internal whitespace runs (space, tab) to a single space.
3. Strip ANSI escape sequences.
4. Do **not** collapse quotes, do **not** rewrite flags, do **not** reorder pipes.
5. Cap at 512 characters; longer commands are truncated at a word boundary and suffixed
   `…` — the cap is applied before hashing so it is deterministic.
6. A command whose text is empty after normalization is dropped, not stored.

### 5.5 Error signatures

An error signature is `class + ":" + normalized_message` where:

- `class` comes from a fixed table (match by prefix, first match wins):
  `permission, not_found, timeout, connection, syntax, type, assertion, quota, conflict,
  cancelled, unknown`.
- `normalized_message` strips: absolute paths (§5.2 rules), hex ≥8, digits ≥2 (replaced by
  `N`), quoted strings (replaced by `"…"`), and line/column numbers.
- Signature capped at 200 characters.

`error.fixed` requires the same signature to have a later success. The definition of
"same" is the signature string, nothing else.

### 5.6 Decisions

`decision.stated` is extracted only from **user-authored** turns (never from assistant
prose, never from tool output). A cue from the fixed lexicon must appear in the first
sentence of the turn; the fact's key is that sentence, whitespace-collapsed and capped at
200 characters. The lexicon is data (`adapters/lexicon.json`), versioned, and its hash is
stored in the snapshot envelope so a lexicon change is visible retroactively.

## 6. Hashing

```
hash = "sha256:" + hex(sha256(utf8(canonical(payload))))
```

Where `canonical()` is §3–§5 applied in order. The hash covers `payload` and **nothing
else** — not `envelope`, not the file's own formatting (a snapshot file is written pretty
printed for humans; the hash is computed on the canonical form).

Consequences, stated as tests:

- Re-serializing a snapshot file with different indentation does not change its hash.
- Re-running extraction with `TZ=Pacific/Kiritimati LANG=tr_TR.UTF-8 HOME=/tmp/x` and a
  fixed clock does not change its hash.
- Adding an envelope field never invalidates a stored hash.
- Changing any canonicalization rule requires a `canonicalization` bump; `verify` on an
  older snapshot reports `schema-older`, not a mismatch.

## 7. Provenance

Every fact carries `evidence[]` = `{path, line, sha256}` where `sha256` is the hash of the
**single transcript line** (raw bytes including trailing newline) that produced the fact.

`dcompact verify --provenance <id>` re-reads the transcript and, for each evidence entry:

- line exists and its hash matches → `backed`
- line exists, hash differs → `drifted` (transcript edited/rotated)
- line missing (file shorter) → `unbacked`
- transcript missing entirely → `unbacked` for every fact, state
  `degraded: provenance-broken`

A fact is `backed` if ≥1 evidence entry is backed; `drifted` if none backed but ≥1 drifted;
`unbacked` otherwise. `verify` reports counts per state and exits `3` when any fact is
`drifted` and the user passed `--strict`.

Provenance is deliberately **line-and-hash**, not byte offsets: offsets are fragile to line
ending and BOM changes, lines are not.

## 8. Retention metadata

`manifest.json`, outside any hash:

```jsonc
{
  "manifest_version": 1,
  "session": "claude-099e41bf-…",
  "snapshots": [
    { "id": "…", "hash": "sha256:6bd0…", "created_at": "…", "facts": 43,
      "pinned": false, "degraded": [] }
  ],
  "pruned": [
    { "hash": "sha256:…", "reason": "retention:count", "at": "2026-09-13T09:00:00Z" }
  ],
  "lock": { "pid": 1234, "host": "…", "started_at": "…" }
}
```

Retention (15 / 72 h) is evaluated on this list. The newest entry is never a prune
candidate. Pins are never candidates. Every prune appends to `pruned` with a reason from
`{retention:count, retention:age, manual, corrupt}`.

## 9. Compatibility

| Change | Action |
|---|---|
| New fact kind | payload `version` bump, `schema_version` minor bump |
| New optional envelope field | `schema_version` patch bump, no migration |
| Canonicalization rule change | `canonicalization` bump; old snapshots readable, `verify` reports `schema-older` |
| Extractor logic change | `extractor_version` bump; provenance re-check expected to fail for old snapshots, reported as such |
| Fact field removal | payload `version` major bump; `dcompact` refuses to read older payload major versions with a clear message |

A snapshot with an unknown `payload.version` is **never** injected and never verified
silently: it is skipped with a warning naming the file.

## 10. Test vectors (required in P2)

Committed under `test/fixtures/`, each a transcript + expected canonical payload + expected
hash:

1. `empty.jsonl` → zero facts, `degraded: ["extraction-empty"]`, stable hash.
2. `single-edit.jsonl` → one `file.modified`, one evidence entry.
3. `merge-order.jsonl` → the same five tool calls in three different input orders → one
   hash.
4. `unicode-nfc.jsonl` → a path written in NFD and again in NFC → merged into one fact.
5. `paths-outside.jsonl` → facts outside the repo root are excluded and counted.
6. `error-cycle.jsonl` → error raised then fixed → both facts, correct `fixed_by`.
7. `unknown-tool.jsonl` → unmapped tool call → `coverage < 1`, `degraded: []`, counter set.
8. `crlf.jsonl` → CRLF transcript → line hashes computed on raw bytes, facts unchanged.
9. `huge-command.jsonl` → 2 KB command → truncated at 512 with `…`.
10. `clock-env.jsonl` → run with perturbed `TZ`/`LANG`/`HOME`/clock → identical hash to
    vector 2.

Every vector is asserted in CI on Linux and macOS. A vector failure blocks release.
