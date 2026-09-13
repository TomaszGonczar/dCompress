# Codex brief — first batch: P0 Foundation, P1 Core engine, P2 Determinism suite

**Issues:** OG-55, OG-56, OG-57
**Waves:** 1 (all three)
**Agent:** Codex, `gpt-5.6-sol`, reasoning effort `xhigh`
**Gate:** OG-57 is a **hard stop**. If determinism cannot be demonstrated, nothing downstream
is allowed to start. Report the failure instead of proceeding.

---

## Your role

You are the first implementer on this repository. There is no source code yet — only design
documents. Your batch establishes the foundation everything else is built on, and two of the
three issues are the highest-leverage work in the project.

You are working on a repository whose **purpose** is saving coding agents from context loss.
You are a coding agent. If you lose track of this task, that is product feedback — note it.

---

## Read before writing anything

In this order. Do not skim SCHEMA; it is normative.

| File | Why |
|---|---|
| `AGENTS.md` | The 10 invariants. Read every one. |
| `docs/CONCEPT.md` | Problem, architecture, invocation model, bug policy |
| `docs/SCHEMA.md` | **Normative.** If your code disagrees with it, your code is wrong. |
| `docs/DEVELOPMENT_PLAN.md` | P0/P1/P2 detail and exit criteria |
| `docs/adr/001-invocation-surface-and-session-identity.md` | Invariants 8 and 9 come from here |

---

## OG-55 — P0 Foundation

Deliverables:

- `package.json` (ESM, `"type": "module"`), `tsconfig.json` (`strict: true`), lint config
  (biome or eslint), `vitest`
- CI workflow: Node 20 and 22, macOS + Linux
- **Dependency policy enforced by lint, not convention:** no `http`, `https`, `net`, `dns`,
  `tls`, `node-fetch`, `axios`, `undici` importable from `src/core/**`. Write the rule, then
  prove it fails by adding a deliberate violation, confirming the failure, and reverting.
- `docs/adr/` — 7 ADRs. ADR 001 is already written; write 002–008 for: rule-based extraction
  (no model); facts not transcripts; determinism as release gate; reversible install; hook
  never fails the host; TypeScript on Node; storage location.
- **Resolve the open decision:** storage location. Recommended: XDG on all platforms with a
  `DCOMPACT_HOME` override. Do not use `~/Library/Application Support` on macOS — one path is
  easier to document, back up, and remove. Record the decision and the reasoning.

Exit: `npm test` green on a repo with no fixtures; CI matrix runs; the dependency lint
demonstrably fails a violation.

## OG-56 — P1 Core engine

Pure functions only. **No `fs`, no `child_process`, no `process.env`, no `Date.now()`.**

- `src/core/types.ts` — `Fact`, `Payload`, `Envelope`, `Snapshot`, `DegradedState`, `AdapterId`
- `src/core/canonical.ts` — `canonicalize()`, `sortFacts`, `mergeFacts`, `normalizePath`,
  `normalizeCommand`, `errorSignature`
- `src/core/hash.ts` — `payloadHash()`, `lineHash()`
- `src/core/clock.ts` — injected `Clock`; the only place `Date.now()` may appear, and it must
  not be importable from `canonical.ts`
- `src/core/extract/` — pure `(NormalizedEvent[], ExtractConfig) → Fact[]`
- `src/core/pack.ts` — pure `(payload, options) → string`

Implement SCHEMA §5 **exactly**. Known edge cases that have already produced a real bug in a
naive implementation — handle all of them:

| Case | Required behaviour |
|---|---|
| Lone surrogate (`"\uD800"`) | **Throw `TypeError`.** Must never emit a literal that degrades to `U+FFFD` — that makes two distinct inputs hash identically. |
| NFC key collision (`"e\u0301"` and `"é"` as distinct keys) | Throw. Do not silently drop one. |
| Key ordering | By **code point**, not UTF-16 code unit. `"\uFFFF"` sorts before `"\u{1F600}"`. |
| `1e21` | Integer-valued but float-typed. Encode as `1000000000000000000000`, no exponent. |
| `-0` | Normalizes to `"0"`. |
| Empty containers | `{}` and `[]` emitted as such, never omitted. |
| Non-ASCII | Emitted literally as UTF-8, never `\uXXXX`. |

Write tests for each row above.

Exit: canonicalization edge-case tests pass; a lint rule proves `src/core/**` cannot import I/O.

## OG-57 — P2 Determinism suite — **THE GATE**

- `test/fixtures/` with all 10 vectors from SCHEMA §10
- `test/determinism.spec.ts` — run extraction under perturbed `{TZ, LANG, LC_ALL, HOME, cwd,
  clock, hostname, os}` and assert byte-equal canonical payload and equal hashes
- `test/seed.spec.ts` — shuffle fixture input order through a fixed permutation list, assert
  the merged fact list is identical
- `npm run gen:vectors` — two-step: writes `*.actual`, a human diffs and promotes. The test
  runner must never be able to silently update an expectation.

**Then prove the suite can fail:** temporarily introduce a nondeterminism (e.g. put a
timestamp in a fact), confirm the suite goes red, revert. Report that you did this and what
you saw. A determinism suite that has never failed is not evidence.

**If determinism cannot be achieved: STOP.** Do not proceed to any later phase. Write up what
failed and why. That outcome is more valuable than a green suite you cannot trust.

---

## Rules for this batch

1. Implement only OG-55 → OG-57, in that order. Do not start P3 or later.
2. Every invariant in `AGENTS.md` is binding. Invariants 8 and 9 (never guess a session;
   never replace `/compact`) are new — respect them even though nothing in this batch
   touches the CLI yet.
3. Every failure path you introduce gets a test in the same change.
4. Do not weaken, skip, or delete a test to get green. If a test looks wrong, say so.
5. Commit per issue using the repository commit format. Reference the issue in the body.
6. Run the suite before finishing. It must pass.
7. **Never edit an expected hash to make a test pass.** Investigate instead.

## What to report back

A short summary containing:

- What you implemented, per issue
- Test output (actual, not paraphrased)
- The deliberate-nondeterminism check from OG-57 and what it showed
- Every place where SCHEMA was ambiguous and what you decided, with reasoning
- Anything you could not satisfy, stated plainly
- Whether you hit the OG-57 gate, and if so, whether it passed

Do not write a summary of the work as new documentation. The commit body and this report are
the record.

## Stop conditions

Stop and report — do not improvise — if:

- Determinism is not achievable (OG-57 gate fails)
- SCHEMA contradicts itself in a way you cannot resolve by reading §5 carefully
- A dependency is genuinely required and would violate the dependency policy
- You find yourself needing to change SCHEMA. **SCHEMA is normative.** Changing it is a
  schema event, not a patch — report it, do not make the change silently.
