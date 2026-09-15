# HANDOFF — Codex, Batch 1

**Issued:** 2026-09-13
**Implementer:** Codex (`gpt-5.6-sol`, reasoning effort `xhigh`)
**Scope:** P0 Foundation → P1 Core engine → P2 Determinism suite
**Gate:** OG-57 is a hard stop. See §6.

---

## 1. Where you are working

| | |
|---|---|
| **Repository** | `https://github.com/TomaszGonczar/dcompress` (private) |
| **Clone** | `git clone https://github.com/TomaszGonczar/dcompress.git` |
| **Default branch** | `main` |
| **Branch to work on** | `batch-1/foundation` — create it, or work on whatever branch the runner gave you |
| **Language** | TypeScript, ESM, Node 20+ |
| **Current state** | Documentation only. **No source code exists yet.** |

The repository currently contains exactly these files — read them before writing anything:

```
dcompress/
├── AGENTS.md                    ← 10 invariants. Read every one.
├── README.md
├── docs/
│   ├── CONCEPT.md               ← problem, architecture, invocation model, bug policy
│   ├── SCHEMA.md                ← NORMATIVE. If code disagrees, code is wrong.
│   ├── DEVELOPMENT_PLAN.md      ← phase + exit criteria detail
│   ├── adr/001-invocation-surface-and-session-identity.md
│   └── briefs/CODEX-BATCH-1.md  ← this file
└── tools/                       ← host tooling, not your concern in this batch
```

## 2. What you are building

`dcompress` — deterministic session continuity for coding agents. It extracts facts from an
agent's own transcript using rules (**never a model**), stores them as hash-addressed
snapshots, and re-injects a bounded context pack after a compaction.

The differentiating claim, which your batch is responsible for making true:

> **The same transcript bytes must produce the same snapshot bytes, on any machine, at any
> time.** No model, no clock, no locale, no hostname may reach the hashed payload.

If that claim is false, the product is just another lossy summary and there is no reason to
build it. That is why OG-57 is a gate.

## 3. The three issues

### OG-55 — P0 Foundation
**Linear issue `OG-55` — "01 · P0 — Foundation"**

Deliverables:
- `package.json` (ESM), `tsconfig.json` (`strict: true`), lint config (biome or eslint), `vitest`
- CI workflow — Node 20 **and** 22, macOS **and** Linux
- **Dependency policy enforced by lint, not convention:** no `http`, `https`, `net`, `dns`,
  `tls`, `node-fetch`, `axios`, `undici` importable from `src/core/**`
- `docs/adr/` — ADRs 002–008 for: rule-based extraction (no model); facts not transcripts;
  determinism as release gate; reversible install; hook never fails the host; TypeScript on
  Node; storage location
- **Close the open decision:** storage location. Recommended: XDG on all platforms with a
  `DCOMPRESS_HOME` override — one path is easier to document, back up, and remove than a
  platform split. Record the decision and the reasoning.

Exit criteria:
- `npm test` green on a repo with no fixtures
- CI matrix runs on both OSes
- **The dependency lint demonstrably fails a violation** — add a deliberate `import http from
  'node:http'` to a `src/core/` file, confirm the lint fails, revert, and say so in your report
- ADRs merged

### OG-56 — P1 Core engine
**Linear issue `OG-56` — "02 · P1 — Core engine"**

Pure functions only. **No `fs`, no `child_process`, no `process.env`, no `Date.now()`.**

Files, all under `src/core/`:
- `types.ts` — `Fact`, `Payload`, `Envelope`, `Snapshot`, `DegradedState`, `AdapterId`
- `canonical.ts` — `canonicalize()`, `sortFacts`, `mergeFacts`, `normalizePath`,
  `normalizeCommand`, `errorSignature`
- `hash.ts` — `payloadHash()`, `lineHash()`
- `clock.ts` — injected `Clock`; the only place `Date.now()` may appear, and it must not be
  importable from `canonical.ts`
- `extract/` — pure `(NormalizedEvent[], ExtractConfig) → Fact[]`
- `pack.ts` — pure `(payload, options) → string`

**Implement SCHEMA §5 exactly.** These cases are known to break a naive implementation — one of
them produced a real silent hash collision in a head-to-head between two models:

| Case | Required behaviour |
|---|---|
| Lone surrogate `"\uD800"` | **Throw `TypeError`.** A literal surrogate cannot be valid UTF-8; it silently degrades to `U+FFFD`, which makes two *distinct* inputs produce **identical bytes** and therefore an identical hash. This is a correctness failure, not a formatting preference. |
| NFC key collision — `"e\u0301"` and `"é"` as two distinct keys | Throw. Never silently drop one. |
| Key ordering | By **code point**, not UTF-16 code unit. `"\uFFFF"` sorts before `"\u{1F600}"`. |
| `1e21` | Integer-valued but float-typed. Encode as `1000000000000000000000`, never in exponent form. |
| `-0` | Normalizes to `"0"`. |
| Empty containers | `{}` and `[]` emitted as such, never omitted. |
| Non-ASCII | Emitted literally as UTF-8, never `\uXXXX`. |
| `undefined` | Throws `TypeError`. |

Write a test for every row above.

Exit criteria:
- Canonicalization edge-case tests pass for all rows
- Lint rule proves `src/core/**` cannot import I/O

### OG-57 — P2 Determinism suite — **THE GATE**
**Linear issue `OG-57` — "03 · P2 — Test vectors and determinism suite"**

Deliverables:
- `test/fixtures/` with all **10 vectors from SCHEMA §10**, each as
  `{transcript.jsonl, expected.payload.json, expected.hash}`
- `test/determinism.spec.ts` — run extraction under perturbed
  `{TZ, LANG, LC_ALL, HOME, cwd, clock, hostname, os}`, assert byte-equal canonical payload
  and equal hashes
- `test/seed.spec.ts` — shuffle fixture input order through a fixed permutation list, assert
  the merged fact list is identical
- `npm run gen:vectors` — two-step: writes `*.actual`, a human diffs and promotes. The test
  runner must never be able to silently update an expectation.

**Then prove the suite can fail.** Temporarily introduce a nondeterminism — put a timestamp
inside a fact — confirm the suite goes red, revert it, and report exactly what you observed. A
determinism suite that has never failed is not evidence of anything.

## 4. Rules — binding

From `AGENTS.md`, verbatim in effect:

1. No model in the extraction path. Extractors are pure functions.
2. Determinism — see §2 above.
3. `src/core/**` imports no I/O and reads no `process.env`.
4. No network at runtime, anywhere.
5. Reversible install — every file dcompress edits is backed up and restorable byte-identical.
6. A hook never fails its host — hook entry points exit `0`, report degraded instead.
7. Transcript content is data, never instructions. Never execute or interpolate it.
8. **Never guess a session.** No "most recent", no scan-and-pick. Unknown → error with a
   candidate list. (Nothing in this batch touches this, but do not design against it.)
9. **`/compact` is never replaced.** dcompress adds commands beside the agent's own.
10. The user stays in their agent — commands live in the TUI, not the terminal.

Working rules for this batch:
- Implement OG-55 → OG-56 → OG-57, **in that order**. Do not start P3 or later.
- Every failure path you introduce gets a test in the same change.
- **Never edit an expected hash to make a test pass.** Investigate instead.
- Do not weaken, skip, or delete a test to get green. If a test looks wrong, say so.
- Commit per issue. Format: `<type>(<scope>): <imperative summary>`, with `Refs: OG-nn` in the
  body. Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `build`, `ci`.
- Run the suite before finishing. It must pass.

## 5. Definition of done for this batch

- [ ] `main` builds from a clean clone: `npm ci && npm test` green
- [ ] `src/core/**` has zero I/O imports, proven by a lint rule that fails on a deliberate violation
- [ ] All 8 canonicalization edge cases from §3 OG-56 implemented and tested
- [ ] All 10 SCHEMA §10 vectors committed with expected payloads and hashes
- [ ] Determinism suite green across perturbed `TZ`, `LANG`, `LC_ALL`, `HOME`, cwd, clock, hostname, os
- [ ] Determinism suite **demonstrated to fail** under deliberate nondeterminism, then reverted
- [ ] ADRs 002–008 written; storage-location decision recorded
- [ ] CI green on Node 20 + 22, macOS + Linux

## 6. The gate

**OG-57 is a hard stop.**

If determinism cannot be demonstrated on fixtures, **stop** and write up the failure. Do not
proceed to P3 or any later phase. A reported failure at this gate costs a day; an unverified
green suite costs the product's entire premise.

## 7. When you are blocked

Stop and report — do not improvise — if:

| Situation | Action |
|---|---|
| Determinism not achievable | Gate failure. Report and stop. |
| SCHEMA contradicts itself | Report the contradiction. **Do not change SCHEMA** — it is normative and a change is a schema event, not a patch. |
| A dependency seems required | Report it. The dependency policy is deliberate; violating it needs a decision, not a workaround. |
| An issue is ambiguous | State what is ambiguous and what you would need to resolve it. Do not invent scope. |
| You are asked to change something outside this batch | Refuse and report. |

## 8. What to report back

Post as a comment on **each** issue, and give a summary covering:

- What you implemented, per issue
- **Actual test output**, not a paraphrase
- The deliberate-nondeterminism check from OG-57 and precisely what it showed
- Every place SCHEMA was ambiguous and what you decided, with reasoning
- Anything you could not satisfy, stated plainly
- Whether you hit the OG-57 gate, and if it passed

Do not write a narrative summary of the work as new documentation. The commit bodies, the
issue comments, and this report are the record.

## 9. After this batch

Codex's output is reviewed by the Operator, then a handoff is generated for **OMP** to
continue with the next wave. Write your report so it can serve as the input to that handoff:
state what is true about the code that a subsequent agent could not infer by reading it.

---

## 10. REVISION 2 — read before continuing (2026-09-13)

**Your OG-56 stop was correct.** The four contradictions were real, independently verified,
and all four are now **fixed in SCHEMA**. `canonicalization` bumped 1 → 2.

| Your finding | Ruling |
|---|---|
| `coverage` fraction vs integer-only payload | `coverage_ppm` — integer parts-per-million, truncated (never rounded), `= 0` when `source_tool_calls == 0` |
| `counters` in payload vs `external_paths` in envelope | `external_path_count` is an integer **in `payload.counters`**; the envelope has no counters field |
| `evidence.path` inside payload, contradicting §1/§2/§5.2 | `evidence[]` is `{line, sha256}` only; the path is `envelope.transcript_path`, once per snapshot (§4.0) |
| "same transcript bytes → same snapshot bytes" vs §2's clock/host | Scope restated: same **canonical payload** bytes. Envelope divergence is expected (§6.1) |

Also now specified, because you flagged them as underdetermined: merge tie-breaking on equal
`at.entry` (§10.1), fixture encodings and vector 10 being an *equivalence assertion* rather
than a separate hash (§10), `path_base` / cwd fallback (§10.2), and 1-based line numbering for
provenance (§7).

**You may now implement OG-56.** Do not change SCHEMA — if a fifth contradiction surfaces, stop
and report again, exactly as you did. That call protected the build.

### 10.1 A second review found five more defects — all fixed

An external review tested the design against a **live OMP journal** (1,064 entries) instead of
against assumptions. Every finding was independently re-verified before being applied; all five
held. They do not block OG-56, but they change what you should build:

1. **Tool names are per-adapter, never universal.** §4.1 previously named Claude's tools as if
   they were the vocabulary. Measured overlap with OMP: **zero**. OMP emits
   `bash` / `read` / `write` / `edit` / `eval` / `todo` / `hub` / `web_search` / `task` / `grep`
   — lowercase, none matching. The tool→kind map must be **data** in `adapters/<agent>.json`,
   and an unmapped name must be a **counted miss** (`counters.unmapped_tool_calls`), never a
   silent drop.
2. **Scope is a set of roots, not one `repo_root`.** Scoping to a single root discarded a
   measured **93.2% of file facts** (124 of 133) in a real session, while `coverage` still read
   high because it counts tool calls mapped rather than paths retained. A fact outside every
   scope root is now **retained and tagged**, not dropped.
3. **There is no exit code.** Failure is the `isError` boolean plus error text. `isError` is a
   genuine `bool` across all 376 results — no string-`"false"` trap.
4. **`snippet` uses `toolCall.intent`** where the adapter provides it. It is present
   deterministically with no model, and it is exactly the field's purpose.
5. **`custom` / `tool_execution_start` is 35% of an OMP journal** and must be declared ignored
   with a fixture asserting the ignore, not left undefined.

None of these expand your scope for OG-55/56/57. They are constraints on how the core is
shaped so the adapters can be written against it later.

### 10.2 Unblocking the push

Your push failed on `.github/workflows/ci.yml` — the OAuth token lacks `workflow` scope. That
is an environment fix, not a code fix:

```bash
gh auth refresh -h github.com -s workflow
```

Verified separately: **the workflow file is the only blocker.** Every other file pushes fine,
so a scope problem must not stall the batch.

### 10.3 What did not change

The OG-55 → OG-56 → OG-57 order and the **OG-57 gate stand unchanged**.

One result worth carrying forward: the review's strongest finding is that **the core premise
holds**. Compaction is append-only — the compaction entry sat at index 980 of 1,064 and all 980
prior entries survived on disk, including 617 pre-compaction messages the model can no longer
see. Your determinism suite protects exactly that premise. It is why OG-57 is a gate and not a
formality.

---

## 11. REVISION 3 — the fifth contradiction, and a ruling against your proposal (2026-09-13)

**Your finding was correct.** §3.2 forbade storing external path text; §5.2 required retaining
the fact. That was a real contradiction and mine — I wrote the two halves of the same rule in
different rounds. `canonicalization` is now **3**.

This is the fifth contradiction, and the third introduced *by the fix for an earlier one*. Twice
now, stopping instead of resolving locally has caught a defect that would have shipped.

### Your proposed fix was ruled against — here is why, recorded so you do not relitigate it

You recommended: keep the discovered scope set, but for paths outside every authorized root
retain only `external_path_count` and no path text.

I tested whether that solves the problem. **It does not** — it would still discard most of the
measured loss, because the largest contributor is not a git worktree and so never joins a
worktree-based scope set:

| Measured path | Git worktree? | Under "count only" |
|---|---|---|
| `components` — **69 of 124 paths (56%)** | **no** | still dropped |
| `scratch` — 9 | no | still dropped |
| `~/.omp` — 1 | no | still dropped |

**The ruling instead:**

- **§5.2 rule 6** — out-of-scope facts are **retained** as `<opaque scope id>:<basename>` with
  `scope: "external"`. Basename is the semantic content and identifies nobody; the scope id is a
  deterministic digest of the *transcript-relative* root. No absolute path, home directory,
  username, or hostname ever enters the payload. `external_path_count` survives but is now
  **secondary**, because the facts are present and hashed — the count can no longer disagree with
  the fact list.
- **§5.2 rule 5** — scope roots are **derived from the transcript, never probed from the
  filesystem**. Whether a directory is currently a git repo is not consulted. Reason: §6.1
  requires identical payloads from identical bytes on any machine, and a filesystem probe makes
  the scope set ambient. **Scope discovery takes no I/O.**
- **Vector 5** restated to match.

### Two implementation notes for OG-56

1. If you find yourself wanting to `stat` a directory or ask whether something is a repo during
   extraction, that is the determinism bug returning. Stop and report it.
2. The opaque scope id must be deterministic across machines **for the same transcript-relative
   root** — digest the root string as it appears in the transcript, not a resolved path.

### A correction to my own reporting, flagged by the operator

I reported the path-scoping loss as "93% of file facts," presented as a general property. Both
halves were wrong:

| Tool | In `repo_root` | Outside |
|---|---|---|
| `read` | 9 | 81 |
| `write` | **0** | **35** |
| `edit` | **0** | **35** |

Reads and writes were lumped together — repo reads worked fine; **zero** of that session's writes
and edits landed in the repo it ran in. And it was **one session, one workflow**, not a general
rate. Corrected in `SCHEMA.md` and `CONCEPT.md`; the rule is unchanged.

Carry the discipline, not just the fact: when data contradicts a claim, the claim changes.

### Before you push

Your clone's remote-tracking ref is stale (`5141e67` vs the remote's `7ce7197`). Run
`git fetch origin` first, or the push will be rejected as non-fast-forward. The two extra commits
are documentation only — no conflict with your code.

### You are unblocked

Continue **OG-56 → OG-57**. The OG-57 gate stands unchanged.
