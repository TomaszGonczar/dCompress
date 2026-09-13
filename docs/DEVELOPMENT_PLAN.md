# dcompact — Development plan A→Z

Target: a public, installable tool that works on a stranger's machine, with a bug policy
that assumes bugs and environment drift as certainties rather than exceptions.

Read [`CONCEPT.md`](CONCEPT.md) first; read [`SCHEMA.md`](SCHEMA.md) before writing any
extraction or hashing code.

---

## 0. Definition of done

The plan is complete when all of the following are true and reproducible from a clean
checkout by someone who is not the author:

| # | Criterion | Proof |
|---|---|---|
| D1 | `npm i -g dcompact` then `dcompact doctor` works on macOS and Linux with no config | CI log on both OSes |
| D2 | `dcompact install --agent claude` then a real compaction in a real Claude Code session produces a snapshot and a working pack | Recorded terminal session, committed under `docs/demo/` |
| D3 | Same criterion for `codex` and `omp` | Same |
| D4 | `dcompact uninstall --agent <x>` restores every touched file byte-identical | `cmp` of backup vs restored, in an automated test |
| D5 | Determinism suite green: identical hashes across perturbed `TZ`/`LANG`/`HOME`/cwd/clock | CI job, both OSes |
| D6 | All 10 test vectors in `SCHEMA.md` §10 pass | CI |
| D7 | Every degraded state in CONCEPT §11.2 is reachable in a test and visible in `doctor --json` | Test matrix |
| D8 | A hook never exits non-zero for an internal error, under fault injection | Fault-injection test |
| D9 | README answers: what it is, install, the one command to try, what it does not do, how to uninstall | README review |
| D10 | Repo published with MIT license, CI badge, changelog, contributing notes | Public URL |

D2–D4 are the ones that cannot be faked. Everything else is diligence.

---

## 1. Phase overview

**Execution order is risk-first, not layer-first.** The phases are numbered P0–P13 for
reference, but they are *executed* in the wave order below. Wave position is what the Linear
board reflects; the P-number is the label.

```
WAVE 1  Foundation + the determinism claim        (pure, no agent needed)
        P0  Foundation          ── repo, toolchain, ADRs, decisions locked
        P1  Core engine         ── types, canonicalization, hashing (no I/O)
        P2  Test vectors        ── determinism proven before real data enters

WAVE 2  Prove extraction works on real data       ← highest-risk assumption dies here
        P4  Adapter recon       ── transcript shapes observed; ADAPTER-SPEC.md
        P6  Claude thin slice   ── transcript → facts → pack on stdout (no store)
        P3  Store               ── snapshots, manifest, lock, retention

WAVE 3  Close the loop end-to-end (gate D2)
        P10 Install/uninstall   ── marker-scoped edits, backups, conflict refusal
        P7  Restore + inject    ── pack renderer, budgets, idempotence, doctor

WAVE 4  Generalize from two real implementations
        P5  Adapter framework   ── extracted from Claude, then validated by Codex
        P8  Codex adapter       ── hooks.json + trust flow
        P9  OMP adapter         ── session hooks + /dcompact
        P11 MCP server          ── portable pull tier: 9 agents, one stdio server

WAVE 5  Ship
        P12a Invocation surface ── slash commands inside the agent; identity plumbing
        P11b generic fallback   ── transcript-from-file, SQLite, git-only tier
        P12 Hardening           ── fault injection, fuzz, property, budgets
        P13 Release             ── packaging, docs, demo, publish
```

**P12a is not optional and is not a wrapper.** ADR 001 establishes that the user is inside
their coding agent when they need this, and that a bare terminal command cannot know which
session it belongs to. Every agent therefore needs a command *inside* it, and OMP specifically
cannot use MCP for this (measured: 14 env vars, no session id) — it needs a native extension.
That is a distinct artifact per agent, so it gets its own phase instead of being folded into
the adapters.

Four departures from the naive layer-first order, and why:

| Move | From → To | Rationale |
|---|---|---|
| **P4 recon** | 5th → 4th | Extractors written against *assumed* transcript shapes produce a tool that works on one machine. Observed shapes first. |
| **P6 Claude** | 7th → 5th | The thin slice (transcript → facts → pack on stdout) tests the product's entire claim — *"rule-based extraction yields facts worth injecting"* — in hours, against real data, with no store or hooks. In the layer-first order that claim stays unfalsified until the 7th phase. |
| **P3 Store** | 4th → 6th | Persistence is not needed to judge whether extraction is useful. Land it once it is known what is worth storing. |
| **P5 framework** | 6th → 9th | An abstraction drawn from one implementation is a guess; from two, it is engineering. Codex then *validates* the framework rather than being written blind against it. |
| **P10 Install** | 11th → 7th | Hooks are the trigger. Without install there is no automatic snapshot and gate D2 is unreachable. |

Wave gates, stated as stops rather than cautions:

- **After Wave 1** — if determinism cannot be demonstrated on synthetic fixtures, stop. Real
  transcripts only add noise. (P2)
- **After Wave 2** — if the preview pack is not visibly more useful than the agent's own
  summary, stop and rethink the fact vocabulary. This is the cheap moment for it. (P6)
- **After Wave 4** — if adding Codex or OMP required a change to `core/`, that change is the
  framework bug, not the adapter's. Record it. (P5)

Each phase is a merge to `main` behind a green CI. No phase starts before the previous one's
exit criteria are met.

---

## P0 — Foundation

**Goal:** a repo a stranger can build, and decisions that stop being relitigated.

Deliverables:
- `package.json`, `tsconfig.json` (strict), `biome.json` or `eslint`, `vitest`.
- Node 20+ and 22 in CI; macOS + Linux runners. Windows: tracked, not gating, until P12.
- Dependency policy enforced in CI: runtime deps limited to a reviewed allowlist; no
  `http`, `https`, `net`, `dns`, `tls`, `node-fetch`, `axios`, `undici` importable from
  `src/core/**` (asserted by a lint rule, not a convention).
- `docs/adr/` with the decisions below written as ADRs, in the project's own voice.

ADRs to write now:
1. **Rule-based extraction, no model.** Rationale: verifiability, determinism, cost, and
   the observation that the agent's own summary is already a worse version of this.
2. **Facts, not transcripts.** Rationale: size, privacy, and the fact that the transcript
   already exists on disk — copying it into a second store is waste.
3. **Determinism as a release gate.** Rationale: a nondeterministic snapshot cannot be
   verified, and an unverifiable snapshot is just another summary.
4. **Reversible install.** Rationale: a tool that edits agent config must be able to leave
   no trace or it will not be trusted.
5. **Hook never fails the host.** Rationale: availability of the agent outranks recording.
6. **TypeScript on Node.** Rationale: hooks are shell commands; a single-file CLI with no
   runtime deps installs everywhere; OMP extensions are already TS.
7. **Storage location.** Resolve CONCEPT §13.1 here. Recommendation: XDG on all platforms,
   documented, with a `DCOMPACT_HOME` override; do not use `~/Library/Application Support`
   on macOS — one path is easier to document, back up, and `rm`.

Exit criteria: `npm test` green on a fixture-free repo; CI matrix runs; dependency policy
lint fails a deliberate violation (test the test); ADRs merged.

---

## P1 — Core engine

**Goal:** pure functions. No filesystem, no clock, no `process.env`, no `Date.now()`.

Deliverables (`src/core/`):
- `types.ts` — `Fact`, `Payload`, `Envelope`, `Snapshot`, `DegradedState`, `AdapterId`.
- `canonical.ts` — `canonicalize(value): string` implementing SCHEMA §5.1 exactly, plus
  `sortFacts`, `mergeFacts`, `normalizePath`, `normalizeCommand`, `errorSignature`.
- `hash.ts` — `payloadHash(payload): string`, `lineHash(rawLine): string`.
- `clock.ts` — injected `Clock` interface; the real implementation is the only place
  `Date.now()` is allowed, and it is not importable from `core/canonical.ts`.
- `extract/` — the extractors, pure `(NormalizedEvent[], ExtractConfig) → Fact[]`.
- `pack.ts` — pack renderer as a pure function `(payload, options) → string`.

Rules: no `fs`, no `path` absolute handling beyond string ops, no `child_process`, no
`process`. `git.state` collection is injected as data, never executed here.

Exit criteria: unit tests for canonicalization edge cases (key order, NFC, empty containers,
integer formatting, path rules, command normalization, error signatures); a lint rule
proves `src/core/**` cannot import I/O.

---

## P2 — Test vectors and the determinism suite

**Goal:** prove determinism before building anything that can hide nondeterminism.

Deliverables:
- `test/fixtures/` with the 10 vectors from SCHEMA §10, each as
  `{ transcript.jsonl, expected.payload.json, expected.hash }`.
- `test/determinism.spec.ts`: for each fixture, run extraction under
  `{TZ, LANG, LC_ALL, HOME, cwd, clock, hostname, os}` perturbations and assert byte-equal
  canonical payload and equal hashes.
- `test/seed.spec.ts`: SHUFFLE the fixture's input entries through a fixed permutation
  list and assert the merged fact list is identical.
- A `npm run gen:vectors` script that regenerates expectations — with a deliberate
  two-step flow (`gen` writes to `*.actual`, a human diffs and promotes) so expectations
  can never be updated accidentally by the test runner itself.

Exit criteria: vectors committed; determinism suite green on both CI OSes; a deliberate
nondeterminism (e.g. including a timestamp in a fact) fails the suite — verified by
temporarily adding one and confirming the failure, then reverting.

---

## P3 — Store

**Goal:** durable, crash-safe, concurrent-safe snapshot storage.

Deliverables (`src/store/`):
- Path resolution: `DCOMPACT_HOME` → XDG data dir → `~/.local/share/dcompact`.
- `writeSnapshot` — temp file, fsync, atomic rename; never a partial file.
- `readSnapshot` — parse, validate against schema, verify hash on read by default.
- `manifest.ts` — rebuild-from-directory when inconsistent; report the rebuild.
- `lock.ts` — advisory lock `{pid, host, started_at}`; wait ≤1 s; break stale locks
  (>30 s old with a dead pid) and log the break.
- `retention.ts` — 15 / 72 h, pins exempt, newest never pruned, deletions logged with
  reason; `--dry-run` supported everywhere.
- `quarantine` — a hash-mismatched snapshot is renamed `*.corrupt` and never injected.

Exit criteria: tests for atomic write under a simulated crash (SIGKILL a child mid-write
and assert no partial file), concurrent writers (two processes, assert two distinct
snapshots and a consistent manifest), stale lock break, corrupt snapshot quarantine,
retention boundaries (15th/16th snapshot, 71 h/73 h, pinned oldest, clock jump backwards).

---

## P4 — Adapter recon (no code shipped, an artifact produced)

**Goal:** replace every assumption in CONCEPT §7 with an observed fact, and freeze the
adapter contract.

This phase produces a document, `docs/ADAPTER-SPEC.md`, and nothing else. It is the phase
most likely to be skipped and the one that most determines whether the tool works on other
people's machines.

For each agent, record: config file paths and precedence; hook event names; exact stdin
payload schema; output contract per event; whether injection is possible and how; how the
agent reports its version; transcript path and layout; tool-name vocabulary actually seen;
and the **real** failure modes.

Evidence rules: shapes are captured from real files on this machine and from first-party
docs, and each claim in `ADAPTER-SPEC.md` carries a source marker — `[docs:<url>]`,
`[observed:<path>]`, or `[unverified]`. An `[unverified]` claim cannot be implemented
against; it becomes a P5 task.

Already gathered, to be confirmed and extended:

| Item | Status | Source |
|---|---|---|
| Claude hook events, matchers, stdin fields, `additionalContext`, `PreCompact`/`PostCompact` | Verified | [docs:code.claude.com/en/hooks] |
| Claude transcript JSONL shape (`type`, `message.content[]`, `tool_use.name/input`, `uuid`, `parentUuid`) | Verified | `[observed:~/.claude/projects/…/*.jsonl]` |
| Codex hooks.json three-level shape, trust-by-hash, 1 s `SessionEnd` timeout | Verified | [docs:learn.chatgpt.com/docs/hooks] |
| Codex rollout JSONL (`timestamp, ordinal, type, payload`) | Observed (top-level keys only) | `[observed:~/.codex/sessions/…/*.jsonl]` |
| Codex `response_item` inner schema for tool calls | **Unverified** → P4 task | — |
| OMP extension API, `session_before_compact`, `session.compacting`, `context`, session entries, camelCase `role` | Verified | [docs:omp://extensions.md, omp://compaction.md] |
| OMP journal on-disk shape | Partially observed | `[observed:~/.omp/agent/sessions/…]` |
| MCP config shape across agents (`mcpServers`, stdio) | Verified | OMP MCP docs; `~/.cursor/mcp.json`; `claude mcp list` |

Also produce, per adapter, a **tool-name vocabulary** table from the real transcripts
(`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Read`, `Bash`, `apply_patch`, `shell`, …)
with the observed frequency in the sample. That table is the input to the extractors and the
first place a new agent version will break things.

Exit criteria: `ADAPTER-SPEC.md` merged with zero `[unverified]` claims on the critical path
(Claude, Codex, OMP); every remaining `[unverified]` claim listed in a "blocked"
section with the task that resolves it.

One specific unknown to close here, because it was mis-inferred once already:

- **Pi compatibility.** `pi` is upstream, OMP is the fork. The documented divergences
  (UI architecture, `pkg.pi` vs `pkg.omp` manifest key, `vitest` vs `bun:test`, hooks vs
  extensions naming) mean Pi support cannot be assumed. Either verify the shared surface or
  record explicitly that only OMP is supported in v0.1.

---

## P5 — Adapter framework

**Goal:** adapters as data plus a small mapper, with drift detection built in.

Deliverables:
- `adapters/<agent>.json` — declared config paths, hook entries to install, event map,
  transcript hints, `last_verified_version`, `verified_at`, `fixture_hash`.
- `src/adapters/registry.ts` — load, JSON-Schema-validate, report invalid adapters as
  degraded rather than crashing.
- `src/adapters/normalize.ts` — adapter entry shapes → `NormalizedEvent`.
- `src/adapters/drift.ts` — compare a fixture's shape signature against the live transcript;
  mismatch → `degraded: schema-drift`, stamped into every snapshot from that adapter.
- Coverage accounting: `unmapped_tool_calls` counter with a per-tool-name histogram in
  `doctor --json`.

The framework must make a *new agent* a JSON file plus a mapper function, with no changes to
the engine. If adding an adapter requires touching `core/`, the abstraction is wrong.

Exit criteria: a test-only fake adapter (`test/fixtures/adapters/fake.json`) drives a full
snapshot through the framework; a mutated fake adapter triggers `schema-drift`; an invalid
adapter JSON is reported, not fatal.

---

## P6 — Claude adapter: thin slice, then integration

**Goal:** prove the product's premise against real data, in hours, before building anything
that depends on it. Then close the loop.

### P6a — Thin slice (Wave 2, executed 5th)

**Thin slice. This is the premise test.** Map a real Claude transcript to `NormalizedEvent[]`,
run it through the Wave-1 extractors, print the pack to stdout. **No store. No hooks. No
adapter registry.**

Deliverables:
- Claude transcript mapper → `NormalizedEvent[]`
- Extractors for the tool vocabulary observed in P4
- `dcompact preview --transcript <path>` → pack on stdout
- One real (anonymized) transcript committed as a fixture

The product's entire claim is *"rule-based extraction from a transcript yields facts worth
injecting."* That claim is falsifiable in hours against real data and unfalsifiable from a
spec. Building the store, the install model, or a framework first risks all of that work on
an unvalidated premise.

**Judge the output honestly:**
- Are the facts *useful*, or merely *accurate*? A list of 40 file edits is accurate and
  worthless.
- Do they capture what the agent would forget, or what is already in git?
- What is missing that a human would consider essential after a compaction?

**Stop condition:** if the preview is not visibly better than the agent's own summary, stop
and rethink the fact vocabulary. That is the cheap moment for it.

### P6b — Full integration (Wave 3, executed 8th, with P7)

`install` generating hook entries for `PreCompact`, `PostCompact`, `SessionStart`,
`SessionEnd`; `sessions/<adapter>-<id>/` store wiring; `dcompact snapshot --session <id>`
against real transcripts.

Critical-path detail: `PreCompact` is the only event that runs *before* history is dropped,
so it is the only one that can capture a pre-compaction snapshot of a session about to change
shape. It must therefore be fast and non-blocking (CONCEPT §13.3).

Exit criteria (this is D2): in a real Claude Code session — modify files, `/compact`, confirm
a snapshot with the expected `file.modified` facts appears in `dcompact list`,
`dcompact verify --provenance` reports them `backed`, and the resumed session receives the
pack (verified with a marker string visible in the transcript). Terminal session recorded
into `docs/demo/`.

---

## P7 — Restore, injection, doctor

**Goal:** the pack is correct, bounded, idempotent, and inspectable.

Deliverables:
- `restore` with `--format text|md|json`, `--budget <bytes>` (default 4096), deterministic
  ordering per CONCEPT §8.
- Injection wiring per adapter (Claude `SessionStart.additionalContext`; OMP `context`
  hook; Codex `SessionStart.additionalContext` if supported — confirm in P4).
- Idempotence marker `[dcompact:<hash>]`; re-injection skipped when present.
- `doctor` (human + `--json`): stores found, adapters and their versions, hook integrity
  (markers present, command strings unchanged), trust state where exposed, last successful
  hook timestamp per adapter, degraded states, disk usage, retention summary, drift
  warnings, budgets.
- `dcompact diff <a> <b>` — fact-level diff; the fastest way for a human to judge whether a
  snapshot is good.

Exit criteria: budget enforcement tested at 1×/2×/10× the fact volume; elision notice
appears and counts exactly; injection is skipped on the second call; `doctor --json`
schema-stable and snapshot-tested; every degraded state from CONCEPT §11.2 has a test that
produces it.

### 7.1 Continuity fidelity test

A pack that validates and injects can still be useless if it drops what the next session needs.
This measures whether dcompact actually delivers continuity, rather than merely producing
well-formed output. It belongs here because it needs a working `restore` and injection path.

**Method — pre-registered detail recall, not judgement.** Before the session, plant a fixed list
of details across categories (file path, decision, error→fix, command, open question, negative
constraint). Record the list *before* the run. The score is a count, so it is recomputable by
anyone rather than an impression.

**Three arms**, and the control is essential:

| Arm | Measured |
|---|---|
| A — built-in compaction | planted details surviving in the host's compacted context |
| B — dcompact | planted details surviving in the injected pack |
| C — control, neither | what the model still knows cold, with no compaction |

Without C the test cannot distinguish "dcompact works" from "compaction never hurt here."

**Three artifacts are needed, not one.** A raw transcript alone gives one side of a two-sided
claim:

| Artifact | Source |
|---|---|
| Raw transcript (ground truth) | agent JSONL via `transcript_path` |
| Built-in compaction summary | **`PostCompact` receives `compact_summary`** — capture it there; not otherwise retrievable |
| dcompact pack | `restore` |

The `compact_summary` capture is what makes arm A scorable. Without it the comparison is a vibe.

**Execution: Orca orchestration, not bare terminals.** Supervised orchestration supplies the
coordination and evidence controls this test needs:

```
orca orchestration run-create
orca orchestration task-create --spec …
orca orchestration worker-start --task <id> --agent codex --model gpt-5.6-luna --effort medium --worktree current
orca orchestration worker-read --dispatch <id> --limit <n>
orca orchestration worker-list          # liveness: hung vs slow
```

`--model`/`--effort` per worker makes the comparison reproducible rather than dependent on
whatever a terminal happened to start with. Heartbeat distinguishes a stalled agent from a long
compaction — without it a hung run looks slow and the result is uninterpretable. `worker-read
--limit` gives bounded per-worker output, which makes the surviving-detail count automatable.
ADR 001 rejected this approach because unstructured terminals produced unreadable results: no
completion contract, no liveness signal, no attribution.

**Scale, stated honestly.** Six terminals is anecdote, not evidence. Pick one and say so:

1. **Directional only** — three runs per arm, reported as *"in these runs dcompact retained N
   more planted details"*, with sample size named as a limitation.
2. **Powered** — if a rate is the claim, size the sample first. The DS-3 experience is directly
   relevant: a correlation at n=22 looked real, was not significant, and the fix was more data
   rather than a friendlier test.

Exit criteria for §7.1: planted list committed before the runs; all three arms run including the
control; `compact_summary` captured; per-arm counts recomputed from committed artifacts; a
written verdict — or an explicit statement that the sample was too small to tell. **If dcompact
does not beat built-in compaction, that is the finding.** Do not tune the test around it.

Scope note: this measures **retention of planted specifics**, not semantic correctness of the
pack. Narrower, and it should be said in the verdict.

---

## P8 — Codex adapter

**Goal:** the second agent, exercising the parts of the framework Claude does not.

Deliverables: Codex mapper over `rollout-*.jsonl` (`response_item` → tool calls, `event_msg`
→ errors/status); `hooks.json` generation; `SessionStart`/`PreCompact`/`SessionEnd`.

Two Codex-specific obligations:
- **Trust is a state, not a boolean.** `doctor` reports `untrusted: hook-pending-review`
  until the user runs `/hooks`. The hook command string must be stable across versions
  (no embedded version, no timestamp, no absolute store path) or every upgrade
  self-invalidates — this is a design constraint on `install`, tested by asserting the
  rendered command is byte-identical across two installs from different directories.
- **Timeouts.** `SessionEnd` defaults to 1 s (max 3). The hook must either finish well
  inside that or hand off; measure and record actual latency in CI.

Exit criteria (D3, Codex half): snapshot and pack verified in a real Codex session;
trust flow documented with screenshots; hook latency reported in `doctor`.

---

## P9 — OMP adapter

**Goal:** the richest integration, and the author's daily driver — so it gets the hardest
bar.

Deliverables: `dcompact.ts` extension registering `session_before_compact`,
`session.compacting`, `session_compact`, `context`, `session_start`, `session_shutdown`,
plus `/dcompact` command; journal reader over `ctx.sessionManager.getBranch()` with
camelCase `role` matching (`toolResult`, not `tool_result` — a documented silent-failure
trap).

Exit criteria (D3, OMP half): compaction in a real OMP session produces a snapshot; the
pack is injected via the `context` hook; `/dcompact` reports status inside the TUI; no
extension error in `~/.omp/logs` after a full session.

---

## P10 — Install / uninstall

**Goal:** the riskiest surface in the product, made boring.

Deliverables: the six-step install model from CONCEPT §7.6; `--dry-run`; `--project`
opt-in; `uninstall`; conflict detection; `install --repair`; and the ordering guarantee that
`doctor` can detect a partially-completed install.

Tests that must exist:
- `uninstall` restores byte-identical files (`cmp`, not a parsed comparison) for: clean
  install, install after existing user hooks, install into a file the user later edited
  **inside** the marker block (must refuse and report), install into a file the user edited
  **outside** the block (must preserve their edit and remove only ours).
- Invalid JSON/TOML in the target: install refuses, file untouched.
- Interrupted install (kill between write and verify): `doctor` reports incomplete;
  `install --repair` completes it.
- File permissions preserved; a symlinked config file is refused and left untouched.

Exit criteria (D4): all of the above green, including the byte-identical restore.

---

## P11 — MCP server (portable pull tier)

**Goal:** reach every MCP-capable agent with one implementation, reusing the whole engine.

The server exposes the engine over stdio. No new extraction code, no new protocol design, no
network: `npx -y dcompact mcp` (or the resolved local binary) as a `stdio` server.

Tools exposed (v1):
- `dcompact_restore` — bounded pack, same renderer and byte budget as the CLI
- `dcompact_list` — snapshots for the current session
- `dcompact_show` — one snapshot (`--json` shape)
- `dcompact_verify` — hash and provenance check
- `dcompact_diff` — fact-level diff between two snapshots

Plus MCP **prompts** where the host surfaces them, so `/dcompact:restore` exists as a slash
command in hosts that expose MCP prompts.

**Two things this phase must state and not blur:**

1. **MCP is pull, not push.** A tool runs only when something calls it. An unattended agent
   that has lost context does not know it has forgotten anything, so it will not call
   `dcompact_restore` unprompted. MCP is recovery and inspection, never continuity.
2. **Tier labelling.** `doctor --json` reports `tier: "hooks"` or `tier: "mcp-only"` per
   agent. An MCP-only agent must never be described as having continuity.

Why it is cheap: one server definition (`{"command":"npx","args":["-y","dcompact","mcp"]}`)
is portable across eight MCP clients — Claude Code, Codex, OMP, Cursor, Windsurf, Gemini CLI,
OpenCode, VS Code — and the same JSON shape works in `~/.cursor/mcp.json`,
`.vscode/mcp.json`, and project `.mcp.json`. Note that an MCP client is not necessarily an
agent: VS Code is an editor hosting Copilot, and Cursor and Windsurf carry their own agents.
Reach is counted in clients because that is what the server definition attaches to.

Exit criteria:
- Server starts, lists tools, and `dcompact_restore` returns the identical pack the CLI
  renders for the same snapshot (byte-compare)
- Verified working end-to-end in at least two hosts (Claude Code and OMP, since both read
  `.mcp.json`)
- `doctor` reports `mcp-only` tier correctly for a host with no hook adapter
- A README section states the pull-vs-push distinction in plain language
- No network calls in the server path (extends the dependency-policy lint to `src/mcp/**`)

---

## P11b — generic fallback tier (kept, small)

**Goal:** do something honest when no integration exists at all.

Deliverables:
- `dcompact snapshot --from <transcript>` for any agent whose log is readable
- `dcompact snapshot --from-db <uuid>` (`--experimental`) for SQLite-backed transcripts,
  reporting `degraded: schema-drift` until a fixture exists
- Generic tier: `git.state` + `.gitignore`-respecting mtime scan, labelled `tier: generic`
  in `doctor` and the pack header, so a user is never misled into thinking they have full
  extraction

Exit criteria: unknown agent degrades to generic with a clear message; capability matrix in
`doctor --json` covered by tests.

---

## P12 — Hardening

**Goal:** find the bugs before users do.

- **Fault injection**: a test build where store writes, transcript reads, hook writes, and
  the clock can be made to fail on demand; assert the hook exits 0 and reports degraded in
  every case (D8).
- **Property tests** (fast-check): canonicalization is idempotent; `mergeFacts` is
  commutative and idempotent; `canonicalize(parse(canonicalize(x))) === canonicalize(x)`;
  fact sorting is a total order over generated fact sets.
- **Fuzzing** the transcript parsers with truncated, oversized, malformed, and
  adversarial-input lines (a line containing fake pack headers, ANSI, NUL bytes, 10 MB
  single line).
- **Budgets**: a memory and wall-clock ceiling for the hook path; measured in CI and
  asserted, so a regression is a red build rather than a slow session.
- **Redaction**: pattern tests with a corpus of secret shapes; false-positive review so a
  legitimate fact is not silently redacted into uselessness.
- **Windows**: path, separator, and lock behaviour; promote from tracked to gating here or
  explicitly document "not supported, and why".

Exit criteria: fault-injection matrix green; property tests green with a fixed seed; fuzz
corpus runs clean; budgets asserted; redaction reviewed.

---

## P12a — Invocation surface (slash commands inside the agent)

**Goal:** the user stays inside their coding agent. See [ADR 001](adr/001-invocation-surface-and-session-identity.md).

The user is in the TUI when they need this. A terminal binary makes them leave it, and it
cannot know which session they mean. So every supported agent gets a command *inside* it.

**Deliverables, per agent:**

| Agent | Artifact | Identity channel |
|---|---|---|
| Claude Code | MCP server registration + `~/.claude/commands/dcompact/*.md` | `CLAUDE_CODE_SESSION_ID` from env (verified) |
| OMP | native extension registering `/dcompact` | `ctx.sessionManager.getSessionId()` (verified) |
| Codex | `~/.codex/prompts/*.md` (or hooks), pending P4 | TBD in P4 |

**Commands exposed in-agent:** `/dcompact:restore`, `/dcompact:snapshot`, `/dcompact:list`,
`/dcompact:verify`. Namespaced to avoid colliding with the agent's own built-ins.

**Hard rules:**

- `/compact` is **never** replaced or shadowed. dcompact adds a command beside it.
- No command guesses a session. If the identity channel is unavailable, the command renders
  the candidate list and asks for an explicit id. It never picks "the most recent".
- OMP must **not** use MCP for this path. Measured: OMP hands MCP children 14 env vars with no
  session identifier, so an in-process extension is the only way to know the session.

**Exit criteria:**
- From inside a real Claude Code session: `/dcompact:restore` returns that session's pack and
  demonstrably not another session's (two concurrent sessions, assert no cross-talk)
- From inside a real OMP session: `/dcompact` reports status without leaving the TUI
- `/compact` still behaves exactly as before, verified by running it after install
- With no identity available, the command errors with a candidate list rather than guessing
- No command writes to a session other than its own, asserted by test

---

## P13 — Release

- `npm publish` as an ESM+CJS dual package with a single `bin` entry; verify install from
  the registry into a clean container.
- `CHANGELOG.md` from day one (Keep a Changelog); `CONTRIBUTING.md` with the adapter
  authoring guide (JSON file + mapper + fixture); `SECURITY.md` with the privacy model;
  `LICENSE` MIT.
- `docs/demo/` with the recorded sessions for D2/D3.
- Landing README: one-sentence pitch, the problem in three lines, a 60-second quickstart,
  an explicit "what it does not do" section, and the uninstall line.
- GitHub Actions: test matrix (macOS/Linux × Node 20/22), determinism job, lint, dependency
  policy, release workflow with provenance.
- `.github/ISSUE_TEMPLATE/` with a `doctor --json` attachment request — the single most
  useful artifact for triaging the environment bugs that will constitute most of the
  issue tracker.

Release gates: D1–D10 all true; no `degraded` state that cannot be explained by a test;
`doctor --json` in the issue template.

---

## 2. Test strategy (summary)

| Layer | What | How |
|---|---|---|
| Unit | canonicalization, normalization, merging, sorting, signatures, pack rendering | vitest, table-driven |
| Golden vectors | 10 fixtures from SCHEMA §10 | committed expected bytes + hashes |
| Determinism | env/clock/order perturbation | dedicated CI job, both OSes |
| Property | idempotence, commutativity, round-trip | fast-check, fixed seed |
| Integration | install → hook → snapshot → verify → inject → uninstall against real agents | scripted sessions, recorded; plus a `fake-agent` harness for CI |
| Fault injection | every failure path returns exit 0 and reports degraded | test build with injectable failures |
| Compatibility | adapter fixture hash vs agent version matrix | CI matrix rows per supported agent version |
| Contract | `doctor --json` and pack format stable | snapshot tests on both outputs |

The `fake-agent` harness is the key piece of CI leverage: a tiny program that replays a
recorded hook sequence and transcript, so the full pipeline can be tested on CI without
Claude Code, Codex, or OMP installed. Real-agent tests are run manually per release and
recorded, not run in CI.

---

## 3. Collateral policy (working product will have bugs)

The CONCEPT §11 bug policy is implemented as follows, phase by phase:

| Policy | Implemented in | Enforcement |
|---|---|---|
| Hook never breaks the agent | P6, P7, P12 | Fault-injection suite (D8) |
| Never corrupt user config | P10 | Byte-identical restore test (D4) |
| Never silently extract nothing | P5, P7 | `extraction-empty` degraded state + test |
| Never silently mis-extract | P4, P5 | Fixture hash + `schema-drift` state |
| Degraded states are first-class | P5, P7 | Every state has a test (D7) |
| Determinism is a gate | P2, P12 | Dedicated CI job (D5) |
| Old snapshots never verified wrongly | P1, P3 | `schema-older` reported, not mismatch |
| Deliberate, visible deletion | P3 | Dry-run + prune log |
| Drift is visible before it bites | P4, P5 | `last_verified_version` + `doctor` warning |

Three standing rules for the whole build:

1. **Degrade, never guess.** When a shape is unknown, emit fewer facts and mark degraded.
   A wrong fact is worse than a missing one, because it is injected with the same
   confidence as a right one.
2. **Prefer a refusal to a clever repair.** `install` refuses on an unparseable config;
   `uninstall` refuses on an outside-edited file. Each refusal prints the exact next step.
3. **Every failure path gets a test in the phase that introduces it**, not in a later
   hardening phase. P12 exists to *find unknown* failures, not to write the known ones.

---

## 4. Estimable shape of the work

Sequence, not schedule — the order matters, the dates do not.

```
WAVE 1   P0 ─ P1 ─ P2 ────────────── gate: determinism proven on fixtures
                                            │
WAVE 2   P4 (recon) ─ P6 (thin slice) ──────┤ gate: premise holds — pack beats a summary
                              │             │
                              └─ P3 (store)─┤
                                            │
WAVE 3   P10 (install) ─ P7 (inject) ───────┤ gate: D2 works on Claude, D4 byte-identical
                                            │
WAVE 4   P5 (framework) ─ P8 (Codex) ───────┤ gate: D3a; adding an adapter touches no core/
                    └─ P9 (OMP) ────────────┤ gate: D3b
                                            │
WAVE 4b  P11 (MCP server)  ────────────────────┤ gate: same pack as CLI, 2 hosts verified
                                            │
WAVE 5   P11b (fallback) ─ P12 (hardening) ─ P13 (release) ── gate: D1–D10 all true
```

Dependency constraints that are non-negotiable in this order: P2 before any real data
(determinism must be provable without noise); P4 before P6 (extractors against observed
shapes); P6 before P3 (know what is worth storing before storing it); P3 before P10 and P7
(hooks write to the store); P7 before P5 (injection model exists before it is generalized);
P5 before P8/P9 (adapters validate the framework); P10 before P13 (reversible install before
publishing).

P4 and P2 are the two phases a hurried author skips. Skipping P2 produces a tool that
cannot be verified; skipping P4 produces a tool that works only on the author's machine.

---

## 5. Portfolio framing

What a reviewer should be able to verify in five minutes, without running anything:

- A README that states the problem, the approach, and the limits in plain language, with no
  adjectives doing the work of facts.
- An architecture where the differentiator (determinism) is isolated, specified normatively,
  and tested by a dedicated suite — not asserted in prose.
- A bug policy that names the failure modes and pairs each with a mechanism, rather than
  claiming quality.
- An integration matrix that is honest about which agents get **push** (hooks) and which get
  **pull** (MCP) — and that says plainly that pull is not continuity. The OMP case is worth
  reading: the assumption was that one MCP server would cover it, and measurement killed that
  — OMP hands MCP children 14 environment variables and no session identifier, so the
  integration had to become an in-process extension instead. The reversal is recorded with
  its evidence rather than quietly patched over.
- Committed evidence: recorded sessions, `doctor --json` samples, the test-vector corpus.

The differentiating claim is narrow and defensible: *the agent's memory should be a
verifiable artifact, not a paraphrase.* Everything in the plan exists to make that claim
true rather than aspirational.
