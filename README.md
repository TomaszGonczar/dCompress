# dcompress

Deterministic, rule-based memory for coding agents — no model in the extraction path.

[![CI](https://github.com/TomaszGonczar/dcompress/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/TomaszGonczar/dcompress/actions/workflows/ci.yml)

When a coding agent compacts, it replaces the older half of its own context with a few
paragraphs of model-written prose. `dcompress` takes the opposite approach: it reads the
agent's own transcript with deterministic rules and turns what actually happened — files
touched, commands run, errors raised and fixed, decisions stated — into a bounded,
hash-addressed fact pack that can be verified against the transcript line by line.

> **Status: work in progress — a deterministic core, an experimental Claude Code continuity
> slice, and a Claude-only installer.** Implemented and tested today: `preview`; the
> explicit-session `snapshot`, `restore`, and `hook` commands (the continuity slice, Claude-only,
> backed by its own checkpoint store, never scanning for or guessing a session); the `list`,
> `show`, `verify`, and `doctor` commands plus `prune`/`pin` over a separate, general-purpose
> snapshot store (`src/store/`) that no shipped command writes *snapshots* into yet (only test
> code calls `writeSnapshot` directly); and `install`/`uninstall --agent
> claude`, which edit a Claude settings file's hook entries inside a byte-marked managed region,
> back up every file they touch first, and restore it byte-identical on uninstall — proven by an
> automated `cmp`, not yet by a real compaction in a real Claude Code session. **Not
> implemented:** MCP, the Codex/OMP/Pi adapters, `diff`, `init`, secret redaction
> inside packs, npm publishing, and Windows support. Those remain on the roadmap in
> [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md).

## Try it in 60 seconds

Requires **Node 20 or newer** (`package.json` declares `engines.node >= 20`; CI runs 20 and
22) and npm. No account, no network at runtime, no configuration.

```sh
git clone https://github.com/TomaszGonczar/dcompress.git
cd dcompress
npm ci
npm run build
node dist/cli.js preview --transcript test/fixtures/claude/slice-0001/transcript.jsonl
```

The build step is required: nothing generates `dist/` for you, and `npm ci` does not link a
`dcompress` binary into the repository root. Run the CLI through `node dist/cli.js`.

Expected stdout — a Markdown pack, 1696 bytes for this fixture:

```text
## dcompress context [dcompress:1ebd2c27a646]
Status: ok
Facts: 9 | external: 0 | unmapped: 0 | coverage: 1000000 ppm
Source entries: 8 | tool calls: 7
```

and on stderr, the diagnostic report ending in the payload hash:

```text
payload hash: sha256:1ebd2c27a646e226e18229a76828f90e658795c30b8db22f23618777eaba16c4
```

Re-run it under a different timezone, locale, or `$HOME` and the pack and hash are identical.
[`docs/demo/claude-slice-0001.md`](docs/demo/claude-slice-0001.md) holds the full output with
checksums, and `test/demo.spec.ts` fails if that document drifts from what the CLI renders.
[`docs/demo/claude-continuity-0001.md`](docs/demo/claude-continuity-0001.md) is the stronger
artifact: the same kind of run carried across a compaction boundary, with checkpoint, injection,
and merge included.

Useful flags:

```text
node dist/cli.js preview --help
```

- `--include-evidence` appends the transcript line numbers backing each fact.
- `--max-bytes <n>` bounds the pack size (default 16384). A value too small to hold the
  mandatory header is refused with the exact minimum rather than failing internally.
- `--max-facts <n>` caps how many facts are rendered.
- `--json` prints the payload, the payload hash, per-tool-name coverage (which tool names, if
  any, account for a coverage gap), diagnostics, and degraded state as one JSON object, instead
  of the pack and the text report.

To run it against your own session, pass the `transcript_path` that Claude Code hands its
hooks, under `~/.claude/projects/<slug>/<session>.jsonl`. The command **never** scans for a
session or picks the most recent one: if you do not name a transcript, it refuses.

The experimental continuity slice uses the same explicit identity rule and a disposable,
task-owned store. After a Claude `PreCompact` payload is available, checkpoint and restore it:

```sh
node dist/cli.js snapshot --session <session-id> --transcript <path> --store <dir>
node dist/cli.js restore --session <session-id> --store <dir>
```

For a development hook bridge, pipe the Claude hook JSON to the matching command:

```sh
printf '%s\n' '<claude-hook-json>' | node dist/cli.js hook --event precompact --store <dir>
printf '%s\n' '<claude-hook-json>' | node dist/cli.js hook --event session-start --store <dir>
```

The hook fails open with `{}` on malformed input or an unavailable checkpoint. This slice is
Claude-only and task-owned; it does not edit live Claude configuration.

[`docs/demo/claude-continuity-0001.md`](docs/demo/claude-continuity-0001.md) records the whole
loop — checkpoint at the boundary, injection at `SessionStart`, checkpoint after the compaction,
and the merged pack — against a synthetic two-epoch fixture, pinned byte-for-byte by
`test/continuity-demo.spec.ts`. It also records what the pack loses, because that is the part a
demo is tempted to hide: a next action stated in prose is extracted only when it matches the
decision-cue lexicon, `todo.state` keeps a task's text but not whether it is open or done, and
under a reduced byte budget the todo facts are the first the renderer drops.

## What it does today, and what it does not

| Capability | Status |
|---|---|
| Map a Claude Code JSONL transcript to facts | **Works** |
| Extract `file.modified`, `file.read`, `cmd.run`, `cmd.failed`, `error.raised`, `error.fixed`, `decision.stated`, `todo.state` | **Works** |
| Pair tool calls to their results by ID, over non-adjacent lines | **Works** |
| Count unmapped tool calls and report coverage in parts-per-million | **Works** |
| Deterministic payload and payload hash | **Works** — the same transcript bytes *plus the same extraction inputs* yield the same canonical payload and the same hash, on any machine |
| Refuse rather than guess (no session scanning, no invented `cwd`) | **Works** |
| Byte/fact-budgeted pack with an elision notice | **Works** |
| Explicit-session durable checkpoint store | **Works — experimental Claude-only slice** |
| `restore` / bounded pack for the named session | **Works — experimental Claude-only slice** |
| Claude `PreCompact` / `SessionStart` hook bridge | **Works — Claude only.** `install` writes the real hook command into a live settings file; the checkpoint → compact → resume → inject loop itself is demonstrated only against an explicit session and a synthetic fixture ([`docs/demo/claude-continuity-0001.md`](docs/demo/claude-continuity-0001.md)), not yet inside a real Claude Code session |
| Store: XDG path resolution, atomic snapshot write, hash-verified read, quarantine, manifest, advisory lock, retention | **Works** — `src/store/`, exposed by `list`/`show`/`verify`/`doctor` and written by `prune`/`pin` (retention deletions and the pinned flag); it is a separate format from the continuity checkpoint store above, and no shipped command writes snapshots into it yet (only test code calls `writeSnapshot` directly) |
| `list` / `show` / `verify` / `doctor` (read-only store commands, `--json` supported) | **Works** — `verify --provenance` re-checks facts against the transcript named in the envelope; `doctor` reports the same store's manifest, lock, quarantine, and adapter coverage for one session |
| `prune` / `pin` | **Works** — `prune` applies the existing retention policy (15 snapshots or 72 h, newest and pinned exempt) to one explicitly named session and records each deletion in `manifest.json`; `--dry-run` reports the same set and deletes nothing. `pin`/`--unpin` sets or clears one snapshot's `pinned` flag through the manifest. Both require an explicit `--session`, and `--json` is supported |
| `install` / `uninstall --agent claude` | **Works — Claude only.** Writes or removes dcompress's hook entries in a settings.json inside a byte-marked managed region; every file it edits or creates is backed up first under `<store>/backups/`, and `uninstall` restores it byte-identical (`cmp`-verified in an automated test, D4) or removes a file dcompress created; `--dry-run` prints the plan without writing. Not yet exercised against a real Claude Code session and a real compaction (D2) |
| MCP server | **Not implemented** |
| Codex, OMP, Pi, or any second adapter | **Not implemented** |
| `doctor` | **Works** — reports store, manifest, lock, quarantine, and adapter coverage health for one explicitly named session; `--json` supported |
| `diff`, `init` | **Not implemented** |
| `git.state` facts for Claude | **Not implemented** — the core supports them, the Claude adapter does not emit them |
| Secret redaction | **Not implemented** — planned for the hardening phase |
| npm publish / `npm i -g dcompress` / `npx dcompress` | **Not available** — the package is `private: true` |
| Windows | **Not tested** — CI covers Ubuntu and macOS only |

The continuity commands are intentionally narrow: they require an explicit session, transcript
and/or store path, and support Claude only. A PreCompact starts a new injection epoch even when
the payload hash is unchanged; repeated SessionStart(compact) delivery in that epoch is suppressed,
while every SessionStart(resume) injects because resume is a fresh context. Restore unions degraded
states from the whole verified chain. Facts from earlier checkpoints remain historical and are marked
`unbacked` unless they are present in the newest checkpoint; source counters always describe the
newest input tuple. Since checkpoints are cumulative, continuity merges same-identity numeric attrs
with deterministic max rather than summing them across epochs. `install`/`uninstall` add a
narrower surface of their own — Claude only, and unproven against a live session (see the table
above); general, multi-agent installation and agent discovery still belong to later phases.

## How it works

```mermaid
flowchart LR
    T["Claude Code transcript.jsonl"] --> A["adapter: normalize records, no I/O"]
    A --> E["core extractors: pure functions"]
    E --> C["canonical payload"]
    C --> H["sha256 payload hash"]
    C --> P["pack renderer: priority-ordered, byte-budgeted"]
    P --> OUT["stdout: Markdown pack"]
    H -.->|"stderr: payload hash"| DIAG["diagnostics"]
```

- The adapter maps record shapes to normalized events. It never reads a clock, the filesystem,
  or the environment, so every value it emits comes from the transcript bytes.
- Extraction is a pure function `(events, config) → facts`. No model, no I/O, no `process.env`;
  a lint rule in the test suite enforces that `src/core/**` cannot import I/O.
- Canonicalization fixes key order, number form, Unicode normalization, and set ordering, so the
  same inputs produce the same bytes.
- The hash covers the canonical **payload only**. Clock, host, and transcript path live in an
  envelope that is not part of the artifact's identity — see
  [`docs/SCHEMA.md`](docs/SCHEMA.md) §6.1.
- The pack orders facts by priority (decisions, then errors and their fixes, then files, then
  commands), retains as many ordered facts as fit, and emits a visible elision notice.

## Determinism

Determinism is the point of the project, so it is enforced rather than asserted:

- **No model.** No LLM call exists anywhere in the extraction path. See
  [`docs/adr/002-rule-based-extraction-no-model.md`](docs/adr/002-rule-based-extraction-no-model.md).
- **Same inputs in, same hash out.** The committed fixture renders to
  `sha256:1ebd2c27a646e226e18229a76828f90e658795c30b8db22f23618777eaba16c4`
  under perturbations of `TZ`, `LANG`, `LC_ALL`, and `$HOME`, on Node 20, 22, and 26. The
  guarantee is over the transcript bytes **and** the declared extraction inputs — repo root,
  `path_base`, extractor version, canonicalization version — not over the transcript alone;
  `docs/SCHEMA.md` §6.1 states the exact scope.
- **Tested, not promised.** `test/determinism.spec.ts` re-runs every committed fixture under
  perturbed environment, clock, and host inputs; the golden vectors pin exact payload bytes and
  hashes. A non-deterministic payload is a release blocker.

## Privacy

> **Read this before pointing it at a real session.** The facts dcompress prints carry short,
> bounded snippets of transcript text, and **secret redaction is not implemented yet**. Treat a
> generated pack as potentially sensitive: read it before pasting it anywhere. Nothing is
> uploaded — there is no network code in the runtime path — but a pack printed to your terminal
> can still contain a token, a path, or a private note that the transcript happened to contain.
> The bundled demo transcript is synthetic.

### Publishing this repository

Two gates must pass before a checkout of this repository is treated as ready to publish: a scan
for what the commits themselves leak, and a reproduction of the quickstart claim above from a
stranger's position. Passing both is not the same as publishing — this repository is private
(`package.json`'s `private: true` blocks `npm publish`), and OG-83 exports a sanitized `HEAD`
into a separate public repository only once the evidence is final and both gates are green.

#### Privacy and history scan

Every change is scanned before it can be published — the working tree, and the commits the change
adds — by `scripts/privacy-scan.mjs`, which CI runs as its own `privacy` job:

```sh
node scripts/privacy-scan.mjs --json
node scripts/privacy-scan.mjs --history origin/main..HEAD --json
```

It reports host paths, session-id-shaped UUIDs, bearer tokens, API key prefixes, email addresses,
and the user name and host name of the machine it runs on, read at run time so the scan means
something on the machine that wrote the content. A report names the rule, the file, and the line,
never the matched text: a scanner that echoes what it found into a public CI log has published it.
`--history` reads the content commits *added*, because a file deleted in a later commit is still
readable from the repository. `test/privacy-scan.spec.ts` proves that each class is detected, that
the report carries no matched value, and that a secret added and then deleted is still found.

What this gate is not:

- **A pattern scanner, not a guarantee.** It finds the shapes it knows. A path, a credential, or a
  sentence that matches none of its rules passes, and a clean run is not evidence that a transcript
  is safe to publish. Binary files are counted and skipped, and a file the scan cannot read fails
  the run rather than passing quietly.
- **Not redaction.** Secret redaction inside packs is still unimplemented (the box above and
  CONCEPT §9); this gate protects this repository's own commits, not the packs dcompress prints.
- **Not a broad exemption list.** Each allowlist entry is one exact literal with the reason it is
  not a leak — test placeholders, the development sandbox's own paths — and every run reports how
  many occurrences each entry suppressed.

#### Clean-clone reproduction

`scripts/clean-clone-check.mjs` is the other publication gate: it proves the "Try it in 60
seconds" section above is not aspirational. It clones this repository's own `HEAD` into a fresh
temporary directory — never a network fetch — installs from the lockfile and builds with no
inherited `node_modules`, runs the exact command README.md documents, and diffs the resulting
stdout, its byte count, and the stderr payload hash against the values this file states. The
command, the fixture path, the byte count, and the hash are parsed out of the README text itself
rather than hand-copied, so a value that drifts here is exactly what this gate is built to catch:

```sh
node scripts/clean-clone-check.mjs
node scripts/clean-clone-check.mjs --json
```

Exit codes: `0` reproduced, `1` the clone's output, byte count, or hash disagrees with what
README.md claims, `2` a usage error or an internal failure (the clone, install, or build itself
failed, or the README no longer has the shape the parser expects). `test/clean-clone.spec.ts`
unit-tests the parser against synthetic README text and does not itself clone or build; CI runs
the real gate as its own `clean-clone` job, on `ubuntu-latest` only — narrower than the
Ubuntu/macOS test matrix.

What this gate is not:

- **Not a check on any other claim in this file.** It reproduces exactly one command and its two
  stated output properties (byte count, hash); every other row, number, or sentence in this
  README is unverified by it.
- **Not a test of a real network clone.** The source is this checkout's own git history at `HEAD`;
  it says nothing about what a stranger's `git clone <url>` over the network would fetch.

Related design decisions:
[ADR 003 — facts, not transcripts](docs/adr/003-facts-not-transcripts.md) (dcompress stores
extracted facts, never conversations) and CONCEPT §9 for the full security model.

## The OG-61 preview verdict

The preview was built as a deliberate premise test: *can rule-based extraction yield facts
worth injecting?* The honest answer, for the one transcript it was measured on:

> **Premise supported, narrowly.** The preview carries information the agent's own compaction
> summary does not: an evidence-backed user decision, a normalized failure signature, an
> explicit error→fix linkage, merged edit history, omitted read and command activity,
> deterministic replay, and visible extraction health. This is enough to justify continuing.

The limitations, stated as plainly as the verdict:

1. The committed fixture is a **small, completed, synthetic task** — 7 tool calls, 9 facts. It
   is not a long real session.
2. **Most of its file changes are git-visible**, so its advantage over `git status` is not yet
   demonstrated at scale.
3. **No unfinished next action is exercised in the preview fixture** — the open-work case a
   post-compaction resume most needs. The continuity demo does carry an unresolved task across a
   compaction, and shows that the pack cannot say it is unresolved.
4. OG-85 adds an **experimental**, task-owned Claude continuity slice with explicit snapshot,
   restore, and hook commands, and OG-83 adds a Claude-only `install`/`uninstall` with
   byte-identical restore (D4, proven by an automated `cmp`). Neither is the general
   install/integration gate D2: no recorded session shows a real compaction going through an
   installed hook.
5. It measures whether the pack is *useful*, not whether injection improves agent outcomes. The
   three-arm continuity-fidelity test is reserved for a later phase
   ([`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md) §7.1).

## Roadmap

The design targets a tool that installs into an agent, snapshots automatically at compaction,
and restores a verified pack. This checkout has the experimental explicit-session Claude
continuity slice and a Claude-only `install`/`uninstall` that has not yet been proven against a
real Claude Code session; general, multi-agent installation and the other adapters remain future
work. In wave order:

1. **Wave 1 — done.** Core engine, canonicalization, hashing, 10 golden vectors.
2. **Wave 2 — done.** Adapter recon is complete, the Claude thin slice (`preview`) is
   implemented and judged above, and the store (snapshots, manifest, lock, retention) is
   implemented as a library.
3. **Wave 3 — in progress.** The experimental Claude continuity slice and a Claude-only
   `install`/`uninstall` with reversible, byte-identical restore (D4) are both in place; wiring
   and proving the loop inside a real Claude Code session and a real compaction (D2) is what
   remains.
4. **Wave 4.** Adapter framework, then the Codex and OMP adapters, each validated against the
   framework rather than the engine.
5. **Wave 5.** MCP server and the generic fallback tier are not started; a hook
   fault-injection suite (`test/hook-fault-injection.spec.ts`) already proves the hardening
   phase's D8 ahead of the rest of P12 (fuzzing, property tests, budget review), and release
   remains gated on the other waves.

## Design documents

- [`docs/CONCEPT.md`](docs/CONCEPT.md) — the problem, the architecture, the integration matrix,
  and an explicit list of what dcompress is not.
- [`docs/SCHEMA.md`](docs/SCHEMA.md) — **normative.** The snapshot format and the
  canonicalization rules that make hashes reproducible. If code and this document disagree,
  code is wrong.
- [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md) — phases, wave gates, exit criteria,
  and the bug policy.
- [`docs/ADAPTER-SPEC.md`](docs/ADAPTER-SPEC.md) — per-agent integration contract, with an
  evidence marker on every claim.
- [`docs/adr/`](docs/adr) — the accepted decisions, including rule-based extraction, facts not
  transcripts, determinism as a release gate, and reversible install.

## Benchmarks

[`docs/benchmark/native-compaction-retention.md`](docs/benchmark/native-compaction-retention.md)
is an exploratory note on how much context agents' own compaction retains across repeated
cycles, and how `dcompress preview` compared on synthetic event sets. It is explicitly **not** a
product claim: one session per cell, several cells unmeasurable, `dcompress` never run against
the organic transcripts, and the document states which figures are reproducible and which are
not. Nothing in it runs in CI.

## Development

```sh
npm ci
npm test          # vitest: unit, golden vectors, determinism, dependency policy
npm run lint
npm run typecheck
npm run build     # emits dist/, the only shipped surface
```

Golden vectors are regenerated only through `npm run gen:vectors`, which writes `*.actual` for
human review. Never update an expected hash to make a test pass — investigate instead. See
[`AGENTS.md`](AGENTS.md) for the working rules and the ten non-negotiable invariants.

## License

MIT — see [`LICENSE`](LICENSE).
