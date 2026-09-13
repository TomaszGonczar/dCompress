# dcompact — Snapshot schema and canonicalization

Normative. If code and this document disagree, code is wrong.

`canonicalization: 3` — the version below. Any behavioural change to the rules in §3–§6
bumps this value and is a breaking schema event.

**Revision note (3, 2026-09-13).** A fifth contradiction, found by the implementer at the
OG-56 gate and verified before ruling. Like the first four it was a defect in this document,
and like the fourth it was **introduced by the fix for an earlier one** — §3.2 was written in
revision 2's first pass, then §5.2 was rewritten during the OMP review without reconciling them.

| # | Contradiction | Resolution |
|---|---|---|
| 5 | §3.2 forbade storing external path text; §5.2 required retaining the fact. Vector 5 sided with §3.2. | §5.2 rule 6 — facts are retained as **basename + opaque scope id** (no host text); §3.2 — the count is now **secondary**, because the facts themselves are present and hashed |

Two further defects in revision 2's §5.2 were found while ruling, both mine:

- **Scope roots were probed from the filesystem**, which breaks determinism. The same
  transcript would scope differently on a machine where a directory is a git repo and one
  where it is not, producing two different hashes from identical bytes. Scope roots are now
  **derived from the transcript alone** (§5.2 rule 5) — no I/O, no ambient state.
- **The proposed fix would have reintroduced the original bug.** "Keep the scope set, count
  the rest" would still discard 56% of the measured loss, because the largest measured
  contributor (`omega-component-prep`, 69 of 124 paths) is a plain directory, not a git
  worktree, and so never joined a worktree-based scope set.

**Revision note (2, 2026-09-13).** Version 1 contained four genuine internal contradictions,
found during OG-56 implementation by Codex and verified independently before being ruled on.
They are recorded here because a spec that silently changes is worse than one that admits it
changed:

| # | Contradiction in v1 | Resolution |
|---|---|---|
| 1 | §3 `coverage` was a fraction (`0.9871`); §5.1 permits **integers only** in the payload. The zero-denominator case was undefined. | §3.1 — `coverage_ppm`, integer parts-per-million, truncated, explicit zero case |
| 2 | §3 placed `counters` in the payload; §5.2 rule 5 put `external_paths` "in the envelope". The envelope has no `counters`. | §3.2 — `external_path_count` is an integer **in `payload.counters`**; no path text anywhere |
| 3 | §1/§2 place provenance outside the hash; §4/§7 required `evidence.path` **inside** the payload. Normal transcript paths are outside the repo, which §5.2 excludes. | §4.0 — `evidence[]` is `{line, sha256}` only; the path is `envelope.transcript_path`, once per snapshot |
| 4 | The invariant "same transcript bytes → same snapshot bytes" is literally false against §2, which deliberately puts clock/host/cwd in the envelope. | §6.1 — the claim is scoped to **canonical payload bytes**; envelope divergence is expected |

Also specified, having been left ambiguous: merge-order tie-breaking (§10.1), fixture file
encodings and the equivalence nature of vector 10 (§10), `path_base` and cwd fallback
(§10.2), and 1-based line numbering for provenance (§7).

The reviewer's note worth keeping: these were **not** the implementer's misreadings. They were
defects in the normative document, and the correct behaviour was to stop rather than resolve
them locally — which is what happened.

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
    "coverage_ppm": 987100                 // coverage in parts-per-million, integer
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

### 3.1 Coverage is an integer: parts-per-million

`coverage_ppm` is the integer form of
`(source_tool_calls − unmapped_tool_calls) / source_tool_calls`, scaled by 1,000,000 and
**truncated toward zero** (never rounded — rounding can produce `1000000` for coverage that
is not complete, which would hide a real miss).

```
coverage_ppm = floor(1_000_000 × (source_tool_calls − unmapped_tool_calls) / source_tool_calls)
```

This exists because §5.1 permits **integers only** in the payload (no floats in v1), so a
fractional `coverage` could not be encoded. Parts-per-million was chosen over a percentage so
that a single unmapped call out of ~300,000 is still visible.

**Zero-denominator rule.** When `source_tool_calls == 0` there is no ratio to compute.
Define `coverage_ppm = 0` and set `unmapped_tool_calls = 0`. The value `0` means "no tool
calls were seen" — it does **not** mean "bad coverage". A tool reading this field must consult
`source_tool_calls` before interpreting it. This is the case the empty-test-vector exercises.

Rounding, floating point, and division are the three ways to lose determinism in a single
line. All three are avoided here by construction: integer arithmetic only, truncation only,
explicit zero case.

### 3.2 Paths outside the scope set: counted AND retained, never as host text

Out-of-scope paths are **retained as facts** (§5.2 rule 6) and additionally counted in
`payload.counters`:

```jsonc
"counters": {
  …,
  "external_path_count": 0
}
```

The distinction is about **what the payload may contain**, not about whether the fact survives:

| | Fact retained | Counted | Hashed | Host path text |
|---|---|---|---|---|
| In-scope path | ✅ | — | ✅ | repo-relative only |
| Out-of-scope path | ✅ **as basename + opaque scope id** | ✅ | ✅ | ❌ **never** |
| Non-filesystem target (`xd://`) | ✅ with URI scheme tag | — | ✅ | scheme + path, no host |

**No host path text ever enters the payload.** Not an absolute path, not a home directory, not
a username, not a hostname. That prohibition is absolute (§4.0).

What *is* stored is the fact's identity: its **basename** (the semantic content — `x.md` says
what was touched and identifies no one) and an **opaque scope id** — a deterministic digest of
the transcript-relative root, identical on every machine. A user can map an id back to their
own directory locally; the payload cannot be reversed into a host path.

**Why this is not the same as the original bug.** An earlier rule *discarded* out-of-scope
facts. Measured against one real session: 90% of file operations were out of scope (124 of 133),
and — the sharper fact — **zero of that session's writes and edits landed in the repo it ran
in**. dcompact would have recorded nothing about what the session produced, while `coverage`
still read high. Under this rule those facts are present, hashed, and visible; only the host
path text is withheld. The count is therefore a **secondary** signal, because it can no longer
disagree with the fact list.

*Note on the measurement:* it is one session, exercising one workflow (a `cwd` in `Omega-v3`
whose deliverable was written to a sibling directory passed by argument). A session that edits
its own repo measures differently. The rule rests on the structural argument — a single root is
the wrong primitive for an agent that touches sibling directories — with this session as one
instance of the failure, not as a general rate.

An earlier revision of this section said out-of-scope paths were "never stored," which
contradicted §5.2. That wording was wrong: it conflated *not storing host path text* with *not
storing the fact*, and the two are different requirements.

## 4. Facts

One fact = one atomic, transcript-derived statement.

```jsonc
{
  "kind": "file.modified",
  "key": "src/dispatch.ts",             // the fact's identity within its kind
  "at": { "entry": 842, "ts": "2026-09-13T08:12:04Z" },
  "attrs": { "edits": 3, "tools": ["Edit", "Edit", "Write"] },
  "evidence": [
    { "line": 901, "sha256": "…" }
  ],
  "snippet": "Edit src/dispatch.ts — replace retry loop",
  "unbacked": false
}
```

### 4.0 Evidence carries no path

`evidence[]` entries hold `{line, sha256}` and **nothing else**. The transcript path is a
property of the whole snapshot, not of each fact, and it lives in the envelope as
`transcript_path` (§2). This resolves a contradiction between §1 ("provenance lives outside
the hash") and a fact shape that embedded a path inside the payload.

Why this is the right shape rather than a compromise:

- **Every fact in a snapshot has exactly one transcript.** `path` was constant across all
  evidence entries and all facts, so storing it N times stored no information. It was
  redundancy that happened to leak a host path.
- **`line` + `sha256` is sufficient to verify.** Provenance is already defined per line
  (§7). The path adds nothing to the check.
- **One snapshot writes one transcript path**, so the envelope is the correct cardinality.

An *imported* snapshot — one produced on another machine and verified locally — therefore
reads the path from the envelope, and `verify --provenance` reports `unbacked` for every fact
when that path is absent, which is precisely the honest answer.

The `~/.claude/projects/…/x.jsonl` form in earlier revisions was a documentation example, not
a wire value, and it contradicted §5.2 rule 5. Examples in this document are normative only
where they define shape; where one disagrees with prose, the prose wins and the example is a
bug.

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
5. **Scope roots are derived from the transcript, never probed from the filesystem.**

   The scope set is the set of *roots the transcript itself reveals*: repo roots named in
   the agent's own commands and cwd changes, directories explicitly granted to the agent
   (`--add-dir` or equivalent), and the session cwd as recorded in the transcript. **Whether
   a directory happens to be a git repository at snapshot time is not consulted.**

   *Why this is a determinism requirement, not a preference:* the same transcript bytes
   snapshot on two machines must produce the same payload (§6.1). If the scope set were built
   by probing the filesystem — "is this path inside a git worktree?" — then the same transcript
   would scope differently on a machine where that directory is a repo and on one where it is
   not, producing two different hashes from identical input. A filesystem probe inside
   extraction is a determinism bug, and it is prohibited by §5.1's rule that all inputs are
   declared.

   This also means scope discovery needs no I/O: it reads the transcript, which extractors
   already do.

6. **Out-of-scope paths are retained as identity + opaque scope id. Never as raw host text.**

   A path outside every scope root is still a fact — that file was touched, and losing it is
   the defect this rule exists to prevent. What is retained:

   ```jsonc
   {
     "kind": "file.modified",
     "key": "b3f1c2a8e9d4:x.md",        // <opaque scope id>:<basename>
     "scope": "external",               // vs "repo" | "cwd" | "granted"
     "attrs": { "edits": 3 }
   }
   ```

   - **Basename** is retained. It is the semantic content — `x.md` tells a reader what was
     touched, and a basename alone identifies no person and no machine.
   - **Directory components are replaced by an opaque scope id** — a deterministic digest of
     the *transcript-relative* root string, computed the same way on every machine. The user
     can map the id back to a directory locally (`dcompact scope <id>`); the payload never
     contains the path.
   - **No absolute path, no home directory, no username, no hostname** ever enters the payload.
     Absolute home paths are prohibited outright (§4.0).

   **This resolves an internal contradiction.** §3.2 forbids storing external path text; the
   earlier wording of this rule required retaining it. Both intents are satisfied: the fact
   survives at full semantic usefulness, and no host path is stored. §3.2's prohibition applies
   to *host path text* — not to the fact's existence, its scope tag, or its basename.

   `external_path_count` in `payload.counters` (§3.2) remains and is now a **secondary** signal:
   it counts facts whose scope is `external`. Because those facts are also present and hashed,
   the count can no longer disagree with the fact list — which was the failure mode where the
   facts were discarded while `coverage` still read high.

7. Symlinks are not resolved. The literal path the tool was given is the fact's key.
8. If `store.repo_root` is unknown (not a repo), paths are stored relative to
   `store.cwd`, and the payload records `"path_base": "cwd"` so the meaning is explicit.
   `path_base` values: `"repo"` (default) or `"cwd"`.

### 5.3 Sets

These arrays are sets and are sorted + deduped before hashing:

- `payload.facts[].attrs.tools[]` — sorted code-point, deduped
- `payload.facts[].evidence[]` — sorted by `(line, sha256)`, deduped
- `payload.facts[]` — sorted by §4.2
- `payload.counters.by_kind` — keys sorted (this is an object, not an array; "sorted" means
  its keys are emitted in code-point order per §5.1, and it is hashed as part of the payload)
- `envelope.degraded[]` — sorted, deduped (**not hashed** — the envelope is outside the hash
  entirely; this ordering exists only so two envelopes are comparable when diffed)

Nothing else is treated as a set. In particular, `plan.items` and `cmd` ordering keep their
semantic order.

Note the distinction the earlier revision blurred: everything under `payload` is hashed
because the whole payload is hashed. Only `envelope.degraded[]` is sorted-but-unhashed, and
that is a property of the envelope, not of the field's own nature.

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

### 6.1 What "identical output" means — precise wording

The project invariant is written as *"same transcript bytes → same snapshot bytes."* Read
literally against §2, that is **false and cannot be true**: the envelope deliberately carries
`created_at`, `host`, `store.cwd`, transcript mtime, and duration. A snapshot *file* is
host-specific by design, and should be.

The precise claim — and the one the tests enforce — is:

> **Same transcript bytes and the same extraction inputs produce the same `payload`, and
> therefore the same `hash`. The envelope may differ; it is not part of the artifact's
> identity.**

"Same extraction inputs" is load-bearing and means: repo root, `path_base`, extractor
version, canonicalization version, and (where applicable) the git state that `payload.git`
records. These are inputs, not environment: the same code reading the same bytes with the
same inputs must produce the same payload on any machine, at any time.

So "snapshot bytes" in `AGENTS.md` and `CONCEPT.md` is shorthand for **canonical payload
bytes**. Where this document and those disagree on the scope of determinism, this section is
authoritative — and the shorthand should be corrected at the next edit of those files rather
than left to be rediscovered.

Consequences, stated as tests:

- Re-serializing a snapshot file with different indentation does not change its hash.
- Re-running extraction with `TZ=Pacific/Kiritimati LANG=tr_TR.UTF-8 HOME=/tmp/x` and a
  fixed clock does not change its hash.
- Adding an envelope field never invalidates a stored hash.
- Changing any canonicalization rule requires a `canonicalization` bump; `verify` on an
  older snapshot reports `schema-older`, not a mismatch.
- **Two full snapshot files from two machines on the same transcript have equal `hash` and
  unequal bytes.** This is expected and is asserted by the determinism suite.

## 7. Provenance

Every fact carries `evidence[]` = `{line, sha256}` where `sha256` is the hash of the
**single transcript line** (raw bytes including trailing newline) that produced the fact.

The transcript path is **not** in `evidence[]`. It is `envelope.transcript_path`, one per
snapshot (§4.0). Verification resolves it from the envelope, not from each fact.

`dcompact verify --provenance <id>` reads `envelope.transcript_path`, re-reads that file, and
for each evidence entry:

- transcript path absent or not readable → every fact `unbacked`, state
  `degraded: provenance-broken`
- line exists and its hash matches → `backed`
- line exists, hash differs → `drifted` (transcript edited/rotated)
- line missing (file shorter) → `unbacked`

A fact is `backed` if ≥1 evidence entry is backed; `drifted` if none backed but ≥1 drifted;
`unbacked` otherwise. `verify` reports counts per state and exits `3` when any fact is
`drifted` and the user passed `--strict`.

Provenance is deliberately **line-and-hash**, not byte offsets: offsets are fragile to line
ending and BOM changes, lines are not.

**Line numbering is 1-based and counts physical lines**, where a line ends at `\n`. A CRLF
transcript hashes the raw bytes *including* the `\r`, and a trailing final line without `\n`
is still a line. This matters because vector 8 (`crlf.jsonl`) asserts facts are unchanged
across line endings: the line *hash* differs by platform, the extracted *facts* do not.

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

Committed under `test/fixtures/`, each a transcript plus its expected canonical payload and
expected hash.

**Fixture file rules** (these were underspecified and are now normative):

| Artifact | Encoding | Notes |
|---|---|---|
| `*.jsonl` (transcript) | raw bytes, **no** trailing newline added | Vector 8 depends on exact bytes |
| `*.payload.json` (expected) | UTF-8, **pretty-printed** for human review | The hash is computed on the *canonical* form, not this file |
| `*.hash` | UTF-8, single line, `sha256:` + 64 lowercase hex, trailing `\n` | |

The expected payload file being pretty-printed is deliberate: it must be reviewable in a
diff, and the test recomputes canonical form from it. A test that compared raw file bytes
would be testing the formatter, not the canonicalizer.

**Vector 10 is an equivalence assertion, not a separate hash.** It runs vector 2's fixture
under perturbed environment and asserts the resulting hash *equals vector 2's expected hash*.
Two `.hash` files with different values would mean the suite is broken.

| # | Vector | Asserted outcome |
|---|---|---|
| 1 | `empty.jsonl` | zero facts; `coverage_ppm: 0` with `source_tool_calls: 0` (§3.1 zero case); `degraded: ["extraction-empty"]`; stable hash |
| 2 | `single-edit.jsonl` | one `file.modified`; exactly one evidence entry `{line, sha256}`; no `path` key present |
| 3 | `merge-order.jsonl` | the same five tool calls in three input orders → **one** hash, asserted across all three |
| 4 | `unicode-nfc.jsonl` | a path written in NFD and again in NFC → merged into one fact; key is the NFC form |
| 5 | `paths-outside.jsonl` | out-of-scope facts are **retained** as basename + opaque scope id, `scope: "external"`; **no host path text** anywhere in the payload; `counters.external_path_count` equals the number of such facts, so the count and the fact list cannot disagree |
| 6 | `error-cycle.jsonl` | error raised then fixed → both facts, correct `fixed_by` |
| 7 | `unknown-tool.jsonl` | unmapped call → `coverage_ppm < 1000000`, `unmapped_tool_calls >= 1`, `degraded: []` |
| 8 | `crlf.jsonl` | line hashes differ from an LF twin (raw bytes), extracted **facts identical** |
| 9 | `huge-command.jsonl` | 2 KB command → truncated at 512 chars with `…`, truncated at a word boundary |
| 10 | `clock-env.jsonl` | perturbed `TZ`/`LANG`/`LC_ALL`/`HOME`/cwd/clock/hostname → hash **equals vector 2's** |

### 10.1 Merge-order provenance ties

Vector 3 exercises merging, which raises a question the earlier revision left open: when two
facts merge, `attrs` scalars keep the value from the **later** `at.entry` (§4.3), but the
merged fact's `at` keeps the **earliest**. If two facts have the same `(kind, key)` and the
same `at.entry`, the merge is order-dependent unless the rule is total.

Normative rule: **when `at.entry` is equal, `attrs` scalars keep the value from the entry
that is later in the source file order (higher `line`).** If `line` is also equal, the facts
are identical by definition and the merge is a no-op. This makes the merge a total order over
`(at.entry, evidence[0].line)` and removes the last nondeterminism from vector 3.

### 10.2 cwd fallback and `path_base`

Vector 5 runs in a non-repo directory for at least one case. When `store.repo_root` is
unknown, §5.2 rule 7 applies: paths are stored relative to `store.cwd` and the payload records
`"path_base": "cwd"`. **`path_base` is part of the payload and therefore part of the hash** —
so the same transcript snapshotted with and without a repo root legitimately produces two
different hashes. That is correct, not a bug: the extraction inputs differed (§6.1).

Every fixture declares its expected `path_base` explicitly, so a test cannot pass by
accident of where it ran.

Every vector is asserted in CI on Linux and macOS. A vector failure blocks release.
