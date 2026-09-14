# OG-86 medium benchmark v1 — preregistration

Status: **inputs drafted; scored execution blocked until Stage 0 passes.** This benchmark is
directional evidence with `n = 1` per arm. It is not a population rate or a vendor ranking.

## Question

During sustained coding work with four controlled manual Claude `/compact` events, does a
freshly resumed Haiku 4.5 process recover more useful, verifiable work state when it receives:

1. native compacted context only (A);
2. native compacted context plus the exact native summary re-surfaced (B); or
3. native compacted context plus a deterministic dcompact checkpoint pack (C)?

B separates representation from the freshness/salience effect. C versus B is interpretable as
a representation comparison only while neither treatment exceeds 16,384 bytes and their byte
sizes differ by no more than 2×. A versus B estimates salience; A versus C describes the total
dcompact continuity treatment.

## Frozen execution

All arms use Claude Code 2.1.270, requested and record-verified
`claude-haiku-4-5-20251001`, isolated owner-only profiles, the same committed
`reservation-ledger` base, the four prompts in `phase-prompts.json`, and the sequence in
`schedule.json`. The installed Claude version does not reveal the internal compaction
summarizer model; that identity remains explicitly unproven and is symmetric across arms.

Each phase is genuine agent-driven maintenance of a multi-file project. The harness verifies
the test state, then invokes exactly one manual `/compact`. An automatic or extra compaction
invalidates the complete three-arm series.

Claude Code exposes `PostCompact.compact_summary` after `SessionStart(source=compact)`. The
same compact event therefore cannot carry arm B's summary. Before scoring, Stage 0 changed the
schedule for all arms: after `PostCompact`, create the score fork before resuming the parent;
then deliver A's empty treatment, B's exact summary, or C's frozen pack through the next
explicit `SessionStart(source=resume)`. No treatment is injected on `source=compact`.

The score fork receives exactly one frozen treatment file and cannot read the raw session,
profile, dcompact store, rubric, benchmark artifacts, or prior probes. It has no tools. The
source transcript hash must remain unchanged across fork creation and scoring.

After checkpoint four, the source Claude process exits. A distinct process resumes the same
explicit session and is asked to implement the chat-only mixed-validity import atomicity item.
Only the workload and exact test command are permitted. Passing continuation requires all
eight criteria: correct item, correct symbols, atomic rollback, unchanged CLI, unchanged
storage shape, no dependency/global cache, relevant test command, and hidden tests green.

## Ground truth and scoring

`atoms.json` freezes 100 atoms: 25 become eligible after each checkpoint. The category mix per
phase is five file/symbol facts, three requirements, four decisions or negative constraints,
four error/cause/fix link components, four command/test outcomes, three unresolved-state facts,
and two provenance facts.

The deterministic scorer applies Unicode NFC, fixed lowercase, whitespace collapse, and fixed
punctuation removal. A frozen accepted phrase-set scores 1, frozen partial evidence scores
0.5, and missing or contradictory evidence scores 0. Contradictions also increment false
facts. No accepted phrase, atom, category, or contradiction may be added after a scored
response is visible. Unexpected false claims are adjudicated separately by two reviewers and
cannot change primary recall.

Primary targets are final C recall at least 90%, no more than five percentage points of C
decay between checkpoints, zero C false facts, exact C retention of all negative constraints,
unresolved blockers, and error/fix links, and an 8/8 continuation result. Missing a target is a
valid publishable result.

## Validity gates and caps

Stage 0 must prove owner-only isolation, exact resume timing, one treatment copy, parent hash
stability, new-process identity, the tool-denial matrix, assistant model counts, a recomputable
C transcript/checkpoint binding, scorer mutations, and the privacy scan. The discarded
exploration reached approximately 0.19 USD equivalent under an earlier provisional 0.15 USD
cap. The replacement Stage-0 cap was fixed at 0.25 USD before execution; no scored call had
started.

Each scored arm is capped at 60 minutes, 48 assistant turns, four compactions, and 0.35 USD
equivalent. The medium series is capped at 210 minutes and 1.20 USD equivalent. Any rate limit,
fallback model, unplanned compaction, permission failure, treatment mismatch, source/store
mismatch, failed acceptance state, privacy leak, lost evidence, scorer error, or cap breach
invalidates the whole series. A repair creates a new version and reruns all three arms.

Arm order is derived only after the preregistration commit by sorting A/B/C on
`sha256("OG86-medium-v1|<commit>|<arm>")`; public run artifacts use blinded labels X1/X2/X3
until scores and false-fact adjudication are frozen.

## Privacy and publication

Raw Claude transcripts, hook payloads, session ids, absolute paths, native summaries,
checkpoints, and source-to-placeholder maps remain outside Git. Only the synthetic workload,
frozen inputs, sanitized manifests, neutral responses, recomputable scores, and limitations
are commit-eligible. The benchmark directory and every commit added by its PR must pass the
privacy/history scan before publication.

The large seven/eight-compaction stage is not authorized by this document. It receives a new
preregistration only if the complete medium series is valid and the Wednesday publication
margin remains safe.
