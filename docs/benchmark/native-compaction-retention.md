# Benchmark note — native compaction retention

**Status: exploratory observation, n = 1 per cell. Not a rate, not a ranking, and not evidence
that `dcompact` is better than native compaction.** One machine, 2026-09-13. Nothing here is a
supported capability or a product claim, and none of it runs in CI.

Two experiments are reported, and they are not comparable to each other:

- **§2 Organic** — a real bug-fix task, compacted natively by Claude and by Codex. `dcompact`
  was **not** run on these transcripts, so this is native-versus-native only.
- **§3 Synthetic** — the committed fixture's task replayed, where native Claude `/compact` and
  `dcompact preview` were both scored on the same event sets. This is a synthetic replay, not
  the organic arm, so the two experiments are **not apples-to-apples**.

Sanitization: no session id, credential, host path, real transcript text, or personal
identifier appears below. Quoted model output concerns disposable synthetic benchmark code.

---

## 1. What is measured, and what is not

| Host combination | Status |
|---|---|
| Claude native `/compact`, synthetic workload | Measured, one session |
| `dcompact preview` on the same synthetic event sets | Measured |
| Claude native `/compact`, organic workload | Measured, one session |
| Codex native compaction, organic workload | Measured native; **no `dcompact` cell** |
| Codex native, synthetic | **Unsupported** — no readable summary to score; effective model unprovable |
| OMP native `/compact` | **Unsupported** — arm cancelled; invocation proven only |
| `dcompact` on Codex / OMP / Pi transcripts | **Unsupported** — no adapter exists |
| `dcompact` + native side by side, live sustained session | **Inconclusive** |

**Models** are named only where proven from the run's own records. Claude: **Haiku 4.5**,
resolved `claude-haiku-4-5-20251001`, effective in both experiments (every assistant record in
the scored sessions carried that one id; no Sonnet or Opus record anywhere). Codex:
**`gpt-5.6-luna`**, effective in the organic arm (12/12 turns; present in the local catalog).

---

## 2. Organic experiment — native Claude vs native Codex

A disposable 60-line Python project with 7 tests was frozen with two genuine logic defects.
Baseline `2 failed, 4 passed`. Both hosts received the identical 6-step work prompt: read both
files, run the suite, diagnose each root cause, fix in place preserving signatures and storage
format, re-run, report. A second work phase added a function plus a test.

A 22-atom rubric was committed **before the first host ran**; its SHA-256 is recorded in the
artifacts. Recall was probed after each compaction with identical neutral questions naming no
file, function, or bug ("What went wrong and why?", "What did you decide not to do, and why?").
Scoring: exact 2, partial 1, missing 0, **false −1**; max 44.

**Work completion is asserted, not assumed.** Both hosts went `2 failed` → `6 passed` →
`7 passed`, verified from saved pytest output. This matters: two earlier attempts were
discarded because the hosts could not perform the work, and in that state every probe scored a
flat 100% — there was nothing to forget. A benchmark here that does not assert post-work state
will silently report that.

### 2.1 Per compaction cycle

**Claude (Haiku 4.5)**

| Probe | Score /44 | Exact/partial/missing/false | Retention vs control |
|---|---:|---|---:|
| control | 32 | 16/0/6/0 | — |
| after compaction 1 | 31 | 15/1/6/0 | 96.9% |
| after compaction 2 | **6** | 4/0/16/**2** | **18.8%** |

Compaction metadata: cycle 1 `manual`, 30,523 → 3,407 tokens, 27,116 cumulative dropped;
cycle 2 `manual`, 31,592 → 3,342, 55,366 cumulative dropped.

**Codex (`gpt-5.6-luna`)**

| Probe | Score /44 | Exact/partial/missing/false | Retention vs control |
|---|---:|---|---:|
| control | 33 | 16/1/5/0 | — |
| after compaction 1 | 33 | 16/1/5/0 | 100.0% |
| after compaction 2 | 31 | 15/1/6/0 | 93.9% |

These rows score the model's **answers to post-compaction recall probes**, not Codex's
compaction summary text, which is encrypted and unreadable — see §4 for that distinction.

Compaction metadata: cycle 1 window → 1, 25,091 input tokens; cycle 2 window → 2, 25,239.

Codex produced **0 false facts** across the arm and recovered provenance and failure→fix
linkage at every probe. Claude's cycle-2 loss was total for causal content: file identities
survived 6/8, causes/decisions fell 8/8 → 0/8, fix linkage 4/4 → 0/4, and the error category
went negative because two probes asserted a false negative.

### 2.2 The demonstrated failure mode

After compaction 2, asked what went wrong, Claude answered:

> "Nothing went wrong. This was routine maintenance, not bug fixing. The task was
> straightforward: add new functionality."

and asked what was deliberately not done:

> "No strategic decisions were needed—the specification was clear and complete."

**Both are false.** A bug-fix episode occurred, two tests failed and were fixed, and
preserved-signature plus no-storage-rewrite were explicit constraints the same model had
reported correctly minutes earlier. The failure mode is **confident falsehood about the user's
own recent work**, not admitted uncertainty — worse than a gap, and invisible to a naive
"did the summary contain the fact?" check.

This is an existence demonstration, not a rate. The quoted statements were verified from the
run's saved probe logs.

---

## 3. Synthetic experiment — native Claude `/compact` vs `dcompact preview`

The committed fixture's task was replayed as a real session and compacted manually. Ground
truth is the **observed** event set, not the intended one: in the small arm the shell tool was
denied, so the intended failure→fix cycle never happened, and asserting it would have scored a
correct summary as wrong. Small = 8 atoms; medium = 10.

**Native Claude `/compact` (Haiku 4.5)**

| Arm | Cycle | Summary bytes | Recall | False facts | Provenance | Fix linkage |
|---|---|---:|---:|---:|:---:|:---:|
| small | 1 | 3,139 | 1.000 | 1 | yes | n/a |
| small | 2 | 763 | 0.250 | 0 | yes | n/a |
| medium | 1 | 3,797 | 0.900 | 0 | yes | yes |
| medium | 2 | 3,507 | 0.900 | 0 | yes | yes |
| medium | 3 | 4,131 | 1.000 | 0 | yes | yes |
| medium | 4 | 4,711 | 1.000 | 0 | yes | yes |

The single small-cycle-1 false fact is a **scorer artifact, reported rather than tuned away**:
the summary lists the *requested* plan under "Primary Request" while correctly stating under
"Errors and fixes" that no errors occurred.

**`dcompact preview` on the identical event sets**

| Event set | `--max-bytes` | Pack bytes | Recall | False facts | Provenance | Fix linkage |
|---|---|---:|---:|---:|:---:|:---:|
| small | 16,384 (default) | 826 | 0.750 | 0 | yes | n/a |
| small | 400 | 392 | 0.250 | 0 | yes | n/a |
| medium | 16,384 (default) | 1,780 | 0.800 | 0 | yes | yes |
| medium | 900 | 223 | 0.000 | 0 | no | no |
| medium | 400 | 223 | 0.000 | 0 | no | no |

Summary: **at the default budget `dcompact` recovered 75–80% of the rubric with 0 false facts**
on these synthetic event sets. Its misses are structural: it does not emit `decision.stated`
for a non-cue plan statement, and it reports `file.modified` once per file rather than per edit.
Byte pressure affects the two event sets differently — on the small set a 400-byte budget still
yielded a 392-byte pack with 0.250 recall, whereas on the medium set both 900 and 400 bytes
collapsed to the same 223-byte pack (header plus elision notice, admitting no fact group) with
recall 0.000. (The small set's 900-byte row was byte-identical to its default row and is omitted
here.)

These rows came from task-owned synthetic transcripts that no longer exist, so the table is
**reported evidence, not reproducible**. Running the README command against the *committed*
demo fixture gives different byte counts because it is a different transcript.

---

## 4. Unsupported and inconclusive cells

- **Codex native summary *text* is not inspectable.** Compaction ran and did compact (101,730 →
  5,185 tokens), but the summary is stored as `encrypted_content` with an empty `message` field,
  so no one — including this benchmark — can read what Codex's summary literally said. Nothing
  in §2 contradicts that. The two measure different things: §2 scores the **model's answers to
  neutral recall probes asked after** the native compaction, which are ordinary readable model
  responses and do not require decrypting the summary; it never scores the summary text itself.
  What is therefore unavailable is *why* a fact survived — whether the summary carried it or the
  model recovered it some other way — not *whether* the model could still report it.
- **OMP native `/compact` — arm not completed.** The command is real (`/compact` with
  subcommands `soft | remote | snapcompact`; there is no `/compress` command — `compress` is
  the command's *icon id*, plus an unrelated CLI verb). Driven over RPC it returned
  `success: true` with a structured handoff summary. The multi-cycle arm was cancelled on a
  timebox, so only invocation and output shape are claimed.
- **`dcompact` on current live Claude sessions — degraded.** `dcompact preview` reports
  `degraded: schema-drift` (9 `conversational-content-not-text` diagnostics) on live
  post-compaction sessions, because it does not model `system` / `compact_boundary` records.
  That is a real gap worth an issue — the record type that exists only *after* a compaction is
  one `dcompact` degrades on — and it is not a retention result.
- **`dcompact` on Codex, OMP, or Pi — unsupported.** No adapter exists, so no cross-host
  `dcompact` cell is possible.
- **Synthetic Codex cell — not claimed.** `gpt-5.6-luna` was exercised, but the effective model
  for the compaction itself was not provable from that probe.

---

## 5. Limitations and confounds

**Every number is n = 1 per cell** — one session per arm, one model per host, one codebase, one
task, one machine, one day. It cannot support any rate, ranking, or vendor-behaviour claim.

The Claude and Codex organic arms are **not parameter-matched**, so the retention difference is
**not attributable to the compaction algorithm**. They differ in:

1. **Trigger.** Claude's compactions were invoked manually with `/compact`; Codex's are
   threshold-driven, and the threshold (`model_auto_compact_token_limit=26000`) is a **harness
   knob we chose**, not the product default. At 6000 the same session compacted 27 times.
2. **Pressure turns.** The Codex arm received six explicit "pressure" turns to reach the
   threshold; the Claude arm received none.
3. **Summarizer, prompt, and window management** all differ between the two hosts.
4. **Scale.** Two small logic bugs in a 60-line file is not maintenance at scale.
5. **Scoring.** Recall is hand-scored against permissive regexes; one native miss and one native
   false fact in §3 are acknowledged scorer artifacts, and the rubric's fix-linkage category is
   n/a for the small arm because the event never occurred.

Samples this small can show that a failure **can** happen; they cannot say how often. Claude's
cycle-2 collapse may be an unusually bad draw and Codex's result an unusually good one.

**Before any follow-up:** equalize pressure-turn structure across arms; run ≥5 sessions per host
and report a distribution; score blind to host; control the threshold to separate *how many*
compactions from *which summarizer*; and retain the compaction summary text until scoring is
complete.

---

## 6. What was and was not re-verified

Re-derived when this note was written: the organic matrix (every §2 figure reproduces exactly
from the raw score file), the rubric hash, the model counts from the sessions' own records, the
pytest progression, and the quoted false statements from the saved probe logs.

Not re-verifiable, stated explicitly: **§3's `dcompact` rows** cannot be re-derived because
their task-owned transcripts no longer exist; the §3 native arm runners are gone, leaving the
results matrix and predeclared rubric; and the report's claim that Claude's summary still
*contained* the fix — which would make the observed failure a retrieval rather than a
representation problem — depended on `isCompactSummary` records in a session transcript
deleted as session hygiene. The false statements survive; that explanation does not.

Raw organic evidence remains in a task-owned temporary directory outside this repository and is
deliberately **not committed**, because it contains real session material that was deleted
rather than published. This repository contains no benchmark harness and no benchmark
fixtures.
