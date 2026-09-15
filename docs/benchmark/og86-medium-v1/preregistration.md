# OG-86 medium benchmark v1 — preregistration

Status: **draft freeze revision. No scored call has started and scored execution is not
authorized.** `stage0-result.json` records `status: pass` for the Stage-0 *execution* gates; that
is neither a freeze authorization nor an authorization to start a scored arm, and the corrections
in "Freeze blockers" are open. This benchmark is directional evidence with `n = 1` per arm, on one
machine, one model, and one workload. It is not a population rate or a vendor ranking.

## Question

During sustained coding work with four controlled manual Claude `/compact` events, does a
freshly resumed Haiku 4.5 process recover more useful, verifiable work state when it receives:

1. native compacted context only (A);
2. native compacted context plus the exact native summary re-surfaced (B); or
3. native compacted context plus a deterministic dcompact checkpoint pack (C)?

A versus B estimates the salience/freshness of re-surfacing the host's own summary. A versus C
describes the total dcompact continuity treatment.

**C versus B is not a representation comparison in this series, at any size ratio.** B re-surfaces
the host's own summary, whose length the protocol does not control; C injects a pack bounded by
the pack budget. Equal 16,384-byte ceilings do not produce equal injected sizes, and no threshold
on the observed ratio can restore control the design never had. Stage 0 measured B at 7,371 bytes
and C at 1,246 bytes (approximately 5.9×) on a single micro-workload; that is one observation and
not a prediction, but it is consistent with the structural reason. Per-checkpoint injected byte
and token counts and their ratio are recorded and reported for every arm as a measured covariate;
no representation claim is derived from them. A size-matched representation comparison requires a
separate preregistration that controls injected size directly.

## Primary evidence and separately labeled follow-up

Primary evidence for OG-86 is the **controlled medium series** defined in this document: three
independent arms, each with exactly four operator-invoked manual `/compact` events at the
frozen checkpoints in "Frozen execution". Compaction timing is controlled and manual by
construction, so this series measures retention across *controlled repeated compaction* only.
It says nothing about natural trigger behavior, automatic compaction, or watermark thresholds,
and it must never be described as if it did.

**Organic natural-exhaustion testing is a separately labeled follow-up, not primary evidence.**
That follow-up runs an organic workload until the host compacts on its own, three to six times, and
is reported under its own label. It is not authorized by this document, it is not a substitute for
this series, and it requires its own preregistration, its own freeze commit, and its own validity
gates. The same holds for the staged 7–8 compaction large series, which also remains unauthorized.

## Frozen execution

All arms use Claude Code 2.1.270, requested and record-verified
`claude-haiku-4-5-20251001`, isolated owner-only profiles, the same committed
`reservation-ledger` base, the four prompts in `phase-prompts.json`, and the checkpoint order
below. The installed Claude version does not reveal the internal compaction summarizer model;
that identity remains explicitly unproven and is symmetric across arms.

Required order at every checkpoint, in every arm:

1. Send the frozen phase prompt to the source session, run `npm test`, and verify phase
   acceptance.
2. Invoke exactly one manual `/compact`.
3. Wait for `PostCompact` and capture the native summary.
4. Create the score fork from the compacted source **before any treatment reaches the source**,
   and record the source transcript byte count, line count, and SHA-256.
5. Resume the score fork in a new process with exactly one frozen treatment, tools disabled, and
   ask the neutral probe.
6. Re-read the source transcript and require byte-identical stability across fork creation and
   probing.
7. Resume the source in a new process with exactly one arm treatment and continue.

`schedule.json` currently lists the source resume before fork creation. That order is superseded by
step 4 above, is a freeze blocker, and must be corrected before the freeze commit. No treatment is
injected on `source=compact`; treatment is delivered only on the next explicit
`SessionStart(source=resume)`, because Claude Code 2.1.270 emits `SessionStart(compact)` before
`PostCompact` and the same compact event therefore cannot carry arm B's summary. An automatic or
extra compaction invalidates the complete three-arm series.

Each phase is genuine agent-driven maintenance of a multi-file project.

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

## Validity gates and limits

Stage 0 must prove owner-only isolation, exact resume timing, one treatment copy, parent hash
stability, new-process identity, the tool-denial matrix, assistant model counts, a recomputable
C transcript/checkpoint binding, scorer mutations, and the privacy scan. Stage 0 has run:
`stage0-result.json` records `status: pass` with `scoredCallsStarted: false`. The discarded
exploration reached approximately 0.19 USD equivalent under an earlier provisional 0.15 USD cap;
the replacement Stage-0 cap was fixed at 0.25 USD before execution, and the complete Stage-0 run
recorded 0.143467 USD equivalent against it. No scored call had started.

Hard validity stops, unchanged from the frozen design: any automatic or unscheduled compaction; a
model id other than the frozen one; a failed phase acceptance state; absent or late treatment; a
source transcript that changes during fork creation or probing; raw-artifact access by a probe or
continuation process; raw session, path, or prose leakage into a public artifact; a lost or
unverifiable evidence artifact; a scorer error; an exceeded wall-clock or assistant-turn limit; or
a breach of the emergency runaway ceiling. **Cost figures are not a validity stop** — see "Cost".

Each scored arm is limited to 60 wall-clock minutes, 200 assistant turns, and four manual
compactions. The medium series is limited to 210 minutes. A repair creates a new version and
reruns all three arms.

**Revision note (assistant-turn ceiling, 2026-09-15).** The frozen figure was 48, calibrated
before any real `--execute` measurement existed. The first real attempt against the corrected
protocol measured 47 assistant records for phase 1 of arm C alone -- one of four
comparably-scoped phases (`phase-prompts.json`: each asks for a similar diagnose/implement/test/
report task across several files) -- essentially exhausting the old per-arm ceiling in one
quarter of the work. Recalibrated to 200 (~4x the measured single-phase figure, rounded up for
cross-phase variance) rather than raised silently: this note and the code comment beside
`FROZEN.assistantTurnsPerArm` record why. The wall-clock ceiling was checked against the same
measurement (phase 1: 2.19 of 60 minutes) and is not at similar risk.

Arm order is derived only once the **freeze** commit exists, by sorting A/B/C on
`sha256("OG86-medium-v1|<freeze-commit>|<arm>")`. `protocol.json` carries `freezeCommit: null`
until that commit exists, and no arm order is fixed before it. Public run artifacts use blinded
labels X1/X2/X3 until scores and false-fact adjudication are frozen.

## Cost

Cost is **advisory telemetry, not a scientific validity gate.** These advisory figures are
recorded and reported: 0.35 USD equivalent per scored arm and 1.20 USD equivalent for the medium
series. Exceeding an advisory figure never invalidates an arm or the series and never stops a run
in progress; it is disclosed in the verdict as an observation, alongside the recorded token
counts, the frozen pricing source, and the observed value.

A distinct **emergency runaway ceiling** exists as an operational resource guard, not an evidence
rule: 5.00 USD equivalent per arm and 15.00 USD equivalent for the series. It is set far above the
advisory figures so a legitimate arm cannot reach it, and it can only fire on a pathological loop.
Reaching it aborts the affected arm and is reported as an operational stop with no admissible score
for that arm. It is not a scientific invalidity of the treatment, and it is not a reason to enlarge
the ceiling retroactively.

## Durable sanitized evidence

Every gate value that supports a public claim must be independently recomputable from a committed,
sanitized artifact. A bare boolean is not evidence. Each arm's public result and the Stage-0
manifest must carry, per checkpoint and per labeled process:

- source transcript byte count, line count, and SHA-256 both before fork creation and after the
  probe, together with the stability comparison, rather than a lone "stable" flag;
- labeled process roles and incarnations (work, compact, probe, continuation), not only an
  aggregate count;
- elapsed wall time;
- assistant record counts per labeled process, matching-model record counts, and
  fallback/model-switch counts;
- injected treatment bytes and SHA-256 per arm, and the cross-arm injected-size ratio;
- for C, the retained-prefix byte/line/digest binding, the count of checkpoint evidence entries
  whose hashes matched that prefix, the count required, and a path class that excludes fixture and
  replay directories; `null` for A and B;
- canary occurrence count, private-tree modes, advisory cost telemetry, and the pricing source;
- the exact runner and scorer revision digests the result was produced by.

Artifact generation fails when any gate value is false. Private raw material — session ids, host
paths, hook payloads, native summaries, dcompact stores, and transcript prose — is never promoted
into a sanitized artifact.

## Privacy and publication

Raw Claude transcripts, hook payloads, session ids, absolute paths, native summaries,
checkpoints, and source-to-placeholder maps remain outside Git. Only the synthetic workload,
frozen inputs, sanitized manifests, neutral responses, recomputable scores, and limitations
are commit-eligible.

Freeze scope is explicit. `checksums.sha256` must cover every frozen input **and** every execution
utility that can change a result: the scorer, the Stage-0 runner, the input generator, the privacy
scanner, the benchmark spec, and the Vitest and ESLint configuration, in addition to the workload,
prompts, atoms, rubric, schedule, protocol, preregistration, schema, harness, and Stage-0 files it
already covers. The current manifest omits the scorer, runner, generator, scanner, benchmark spec,
and both configuration files; extending it is a freeze blocker.

History privacy scope is equally explicit: the scan covers the benchmark directory, the complete
diff of the PR that adds these inputs, and **every reachable history object that PR adds**,
including commits reachable only through pull refs. Because those refs retain superseded commits,
the current private repository is not the publication target: after the evidence is final, the
sanitized HEAD is exported into a fresh public repository and verified while logged out.

## Freeze blockers

Open before the first scored call:

1. `schedule.json` checkpoint order (fork and score before source resume), and its residual
   cost clause in the invalidation list. Both live in `schedule.json`, outside this document.
2. Scorer atom independence: absent atoms can still score `exact` because another atom accepts the
   same alias, and most omissions receive partial credit from shared tokens. Accepted-phrase
   collisions must be removed, and the mutation suite must exercise every atom rather than a
   selected one.
3. Continuation tool boundary: a Bash prefix allowance and unconstrained `Glob`/`Grep` are not an
   exact boundary. The matrix must cover every enabled capability and every forbidden location
   class with observed allow/deny probes.
4. A regenerated durable Stage-0 manifest meeting "Durable sanitized evidence", including source
   before/after digests, labeled processes, wall time, and prefix-binding counts.
5. Freeze checksum scope extended per "Privacy and publication".
6. The freeze commit itself, from which arm order, `protocol.json`'s `freezeCommit`, and the
   checksum manifest are derived.

`stage0-result.json`'s `status: pass` is a Stage-0 execution result. It closes none of the items
above and does not authorize a scored arm.

The large seven/eight-compaction stage is not authorized by this document. It receives a new
preregistration only if the complete medium series is valid and the Wednesday publication
margin remains safe. Organic natural-exhaustion testing is separately labeled and independently
preregistered for the same reason.
