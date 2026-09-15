# Reviewer Guide — dCompress

## Review State

* **Evidence commit:** `56c23c19024a1517bbdd779e9b3c731ecf059ed1` (`56c23c1`)
* **Current revision:** `a8b22a8`
* **Test suite:** 516 tests passed across 33 files (Node 20/22 × macOS/Linux CI matrix)
* **License:** MIT · Single-author repository

---

## What This Repository Demonstrates

* **Deterministic rule-based extraction:** Transcript-to-context extraction core with zero model inference in the trust path.
* **Explicit purity and determinism invariants:** Hash-addressed snapshots, strict forbidden-import dependency boundaries, and stable serialization.
* **Executable quality gates:** Automated clean-clone reproduction gate (`test/clean-clone.spec.ts`) proving that a fresh checkout reproduces the documented command, byte count, and payload hash.
* **Self-directed defect discovery & remediation:** Identification and correction of host-path leakage in serialized outputs and Unicode multi-byte truncation defects in string slicing.

---

## What This Repository Does NOT Demonstrate

* **No production deployment:** This is an active core engine under independent development, not a deployed SaaS or multi-tenant service.
* **No multi-contributor team development:** Single-author repository with self-administered PR reviews and CI automation, not human peer review.
* **No completed competitive benchmark:** The OG-86 benchmark against native compaction is preregistered and exploratory; no published win claims are made.
* **No published npm package:** Distributed as source/snapshot only.

---

## Fast Review Path (10 Minutes)

1. **Architectural Decision:** [`docs/adr/002-rule-based-extraction-no-model.md`](docs/adr/002-rule-based-extraction-no-model.md) — Explains why LLM extraction was rejected in favor of deterministic heuristics.
2. **Extraction Engine:** [`src/core/extract/index.ts`](src/core/extract/index.ts) — The rule-based parsing logic.
3. **Canonicalization Core:** [`src/core/canonical.ts`](src/core/canonical.ts) — Normalization, hash computation, and payload formatting.
4. **Determinism Verification:** [`test/determinism.spec.ts`](test/determinism.spec.ts) — Asserting bitwise identical outputs across repeated runs with identical fixtures.
5. **Clean-Clone Gate:** [`test/clean-clone.spec.ts`](test/clean-clone.spec.ts) — Verification from a fresh temporary clone.

---

## Reproduce the Review State

```bash
# Checkout the review commit
git checkout 56c23c1

# Install dependencies
npm ci

# Run test suite
# NOTE: Use 'npm test', not 'npx vitest run' directly — 'pretest' compiles dist/cli.js
npm test

# Run static analysis & typecheck
npm run lint
npm run typecheck
```

Expected output:
* `Test Files: 33 passed (33)`
* `Tests: 516 passed (516)`
* ESLint & TypeScript compile with 0 errors.

---

## One Control Worth Falsifying

**Invariant:** `src/core` must remain pure and never import forbidden host networking or stateful I/O modules (e.g., `node:http`, external network clients).
* Verification: [`test/dependency-policy.spec.ts`](test/dependency-policy.spec.ts) enforces this by inspecting the AST of all source files.
* You can test this control by adding `import "node:http";` to `src/core/canonical.ts` and running `npm run lint` or `npm test` — both gates will fail immediately.

---

## Authorship & AI Assistance

Single-author repository. Tomasz Gonczar owns all requirements, architectural decisions, invariants, acceptance criteria, repository state, and merge decisions. Coding agents (Claude Code / Codex / Antigravity CLI) were used as execution pair-programmers. PR reviews, CI pipelines, and gates are self-administered.

---

## Known Limits

1. **Benchmark phase:** Exploratory testing shows prompt context reduction from 32k to 6k tokens on organic sessions, but full formal benchmark suite remains unexecuted.
2. **Adapter scope:** Production adapter implemented for Claude Code transcripts; other coding agent formats are currently stubs or exploratory.
3. **Single-machine target:** Concurrency and locking are designed for local filesystem processes, not distributed consensus.
