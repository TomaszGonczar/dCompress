# Demo — Claude Code transcript to context pack

This is the artifact OG-61 produced, committed so the claim is inspectable without running
anything. It is byte-reproducible: the command below regenerates this exact output on any
machine, and `test/demo.spec.ts` fails if the quoted pack, report, or hashes drift from what
the CLI renders.

Everything here comes from the committed **synthetic** fixture. No real session, transcript,
or host path is involved.

## Reproduce it

From the repository root, after `npm ci && npm run build`:

```sh
node dist/cli.js preview --transcript test/fixtures/claude/slice-0001/transcript.jsonl
```

The pack goes to stdout; the diagnostic report goes to stderr. Neither stream overlaps the
other, so `> pack.md` captures a clean artifact.

## Checksums

| Artifact | Value |
|---|---|
| Input transcript | `test/fixtures/claude/slice-0001/transcript.jsonl` |
| Input size | 13666 bytes, 20 physical lines |
| Input SHA-256 | `f561627e32ec13de19b4bf5e27bf038741a8bcf71fa0612767aae4a8d3a009f4` |
| stdout pack size | 1696 bytes, 26 lines |
| stdout pack SHA-256 | `90c386c510f822c50e771b602749e1541eed75e1b9bb4fc5207a17e558ac6965` |
| stderr report SHA-256 | `c5529dcbc17d3e78eead1dbd82d889fcf891ddcac2e888a17fa3e05004f3273b` |
| Payload hash (in the stderr report) | `sha256:1ebd2c27a646e226e18229a76828f90e658795c30b8db22f23618777eaba16c4` |

The input hash equals `sanitizedSha256` in
[`fixture.manifest.json`](../../test/fixtures/claude/slice-0001/fixture.manifest.json), so the
committed fixture and this demo cannot silently diverge. The `[dcompress:1ebd2c27a646]` marker
in the pack header is the first 12 hex digits of the payload hash — the same value the report
prints in full.

## Diagnostic report (stderr)

```text
transcript: test/fixtures/claude/slice-0001/transcript.jsonl
bytes: 13666 | physical lines: 20
session: fixture-session-0001 | cwd: /fixture/repo | cli: 2.1.238
records: conversation=18 recognized=17 | tool calls=7 results=7
tools: Bash, Edit, Read, Write
facts: 9 | tool calls: 7 | unmapped: 0 | coverage: 1000000 ppm | path_base: cwd
health: ok
payload hash: sha256:1ebd2c27a646e226e18229a76828f90e658795c30b8db22f23618777eaba16c4
diagnostics: 0
```

Every counter matches the fixture's own `expected` block: 20 physical lines, 7 tool calls and
7 results, 8 normalized events, 9 facts, `coverage_ppm` 1000000, no unmapped calls, no
extraction health problems.

## The pack (stdout)

<!-- demo-pack:start -->
```text
## dcompress context [dcompress:1ebd2c27a646]
Status: ok
Facts: 9 | external: 0 | unmapped: 0 | coverage: 1000000 ppm
Source entries: 8 | tool calls: 7
### Decisions
- **decision.stated** `We must keep this helper dependency-free.`: cue=we must — We must keep this helper dependency-free.

### Errors
- **error.raised** `unknown:Exit code N npm error code ENOENT npm error syscall open npm error path package.json npm error errno -2 npm error enoent Could not read package.json: Error: ENOENT: no such file or directory,`: class=unknown count=1 — Exit code 254 npm error code ENOENT npm error syscall open npm error path package.json npm error errno -2 npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open 'package.json' npm error enoent This is related to npm not being able to find a file.

### Error fixes
- **error.fixed** `unknown:Exit code N npm error code ENOENT npm error syscall open npm error path package.json npm error errno -2 npm error enoent Could not read package.json: Error: ENOENT: no such file or directory,`: count=1 fixed\_by=npm run check — fixed by npm run check

### File changes
- **file.modified** `package.json`: edits=1 tools=Write — Write package.json
- **file.modified** `src/util.ts`: edits=2 tools=Edit, Write — Write src/util.ts

### Failed commands
- **cmd.failed** `npm run check`: last\_error\_class=unknown runs=1 — Run npm check script (expected to fail, no package.json yet)

### Commands
- **cmd.run** `npm run check`: failed=false runs=1 — Run npm check script
- **cmd.run** `ls -la .`: failed=false runs=1 — List directory contents

### Reads
- **file.read** `notes.md`: reads=1 — Read notes.md
```
<!-- demo-pack:end -->

The pack is ordered by fact priority — decisions, then errors and their fixes, then files,
then commands — and drops whole groups from the bottom when a byte budget forces it. In this
transcript the useful content is the user's own constraint (kept verbatim, with its cue), the
failed `npm run check` paired to the later success that fixed it, and the merged edit history
of `src/util.ts`. That pairing is what a prose summary loses.

## What this demo does not show

- **Storage and restore.** `preview` writes nothing. There is no snapshot store, no manifest,
  no injection, and no post-compaction resume path in this repository yet.
- **A large or unfinished session.** The fixture is 7 tool calls and a completed task, so it
  exercises none of the open-work, long-session behaviour that continuity actually needs.
- **Value beyond git.** Most file changes here are git-visible; the pack's advantage over
  `git status` on a large real session is untested.

Those are roadmap items, not regressions. See
[`docs/DEVELOPMENT_PLAN.md`](../DEVELOPMENT_PLAN.md) for the phases that close them, and
[`docs/CONCEPT.md`](../CONCEPT.md) §3 for the full set of things dcompress is not.
