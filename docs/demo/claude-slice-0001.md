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
| stdout json size (`--json`) | 7533 bytes, 262 lines |
| stdout json SHA-256 (`--json`) | `3e3b2264143119742205026253ec5aea5069eb6b3fdcdfd452e8f66891af19f7` |
| Payload hash (in the stderr report and the `--json` output) | `sha256:1ebd2c27a646e226e18229a76828f90e658795c30b8db22f23618777eaba16c4` |

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

## The JSON view (--json)

`--json` replaces both streams with one JSON object: the full payload, its hash, the same
per-tool-name coverage histogram `doctor --json` cannot compute for a stored snapshot (doctor
never re-reads the original transcript, only what a snapshot already persisted), the
diagnostics, and the degraded state. This fixture's seven tool calls all map to a known kind,
so `coverage.unmapped_by_tool` is honestly empty here; `test/claude-adapter.spec.ts` exercises
the non-empty case with a synthetic, deliberately unrecognized tool name.

```sh
node dist/cli.js preview --transcript test/fixtures/claude/slice-0001/transcript.jsonl --json
```

<!-- demo-json:start -->
```json
{
  "payload": {
    "facts": [
      {
        "kind": "decision.stated",
        "key": "We must keep this helper dependency-free.",
        "at": {
          "entry": 2,
          "ts": "2026-01-01T00:00:02.000Z"
        },
        "attrs": {
          "cue": "we must"
        },
        "evidence": [
          {
            "line": 3,
            "sha256": "sha256:826df49355e65037ff90b6c6c6b8c56c5f9141bb24d13d33845a8b84c10f3fb7"
          }
        ],
        "snippet": "We must keep this helper dependency-free.",
        "unbacked": false
      },
      {
        "kind": "error.raised",
        "key": "unknown:Exit code N npm error code ENOENT npm error syscall open npm error path package.json npm error errno -2 npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, ",
        "at": {
          "entry": 11,
          "ts": "2026-01-01T00:00:11.000Z"
        },
        "attrs": {
          "class": "unknown",
          "count": 1
        },
        "evidence": [
          {
            "line": 12,
            "sha256": "sha256:b5f2c56cf618824caacd336db52a3c477d99cb3d01c15d78a8b1457fba00b83a"
          },
          {
            "line": 13,
            "sha256": "sha256:8b107ba50cc1206538b6d1c38bc18d4e96c240f2193baf5413d9f5e73afaa162"
          }
        ],
        "snippet": "Exit code 254 npm error code ENOENT npm error syscall open npm error path package.json npm error errno -2 npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open 'package.json' npm error enoent This is related to npm not being able to find a file.",
        "unbacked": false
      },
      {
        "kind": "error.fixed",
        "key": "unknown:Exit code N npm error code ENOENT npm error syscall open npm error path package.json npm error errno -2 npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, ",
        "at": {
          "entry": 15,
          "ts": "2026-01-01T00:00:15.000Z"
        },
        "attrs": {
          "count": 1,
          "fixed_by": "npm run check"
        },
        "evidence": [
          {
            "line": 16,
            "sha256": "sha256:45b615e82ed9c60625472b5a7624777db11fa13c32bda37bc77956b8695dd80a"
          },
          {
            "line": 17,
            "sha256": "sha256:4bd660a40319c91462aa92ffa39b54be58ea694e102612ac02615ddea4810a32"
          }
        ],
        "snippet": "fixed by npm run check",
        "unbacked": false
      },
      {
        "kind": "file.modified",
        "key": "package.json",
        "scope": "cwd",
        "at": {
          "entry": 13,
          "ts": "2026-01-01T00:00:13.000Z"
        },
        "attrs": {
          "edits": 1,
          "tools": [
            "Write"
          ]
        },
        "evidence": [
          {
            "line": 14,
            "sha256": "sha256:c98b93aac67bfca678806e03a3cb644cca460ff7a8e6caad2b0750fa9058926d"
          },
          {
            "line": 15,
            "sha256": "sha256:50fe1e943795f119a96ad29974b32b90b2d3fcad7345192681129d5547412726"
          }
        ],
        "snippet": "Write package.json",
        "unbacked": false
      },
      {
        "kind": "file.modified",
        "key": "src/util.ts",
        "scope": "cwd",
        "at": {
          "entry": 9,
          "ts": "2026-01-01T00:00:09.000Z"
        },
        "attrs": {
          "edits": 2,
          "tools": [
            "Edit",
            "Write"
          ]
        },
        "evidence": [
          {
            "line": 10,
            "sha256": "sha256:40653b87a07716ffe31193f3f5a9af55fed95666ac6a2d48f60248db249832f3"
          },
          {
            "line": 11,
            "sha256": "sha256:d155d96720d0f608a72711bea493d5f9c20e260a01af2f260e6cde2683183769"
          },
          {
            "line": 18,
            "sha256": "sha256:6f888fa7b900764057993b24d4fc465efea3e204d5d35e3d8b4cb5b36d0d2a99"
          },
          {
            "line": 19,
            "sha256": "sha256:72e17654ddd9402a2520f5ca6874d7bd688562ef7973fd8e2a355787a9986611"
          }
        ],
        "snippet": "Write src/util.ts",
        "unbacked": false
      },
      {
        "kind": "cmd.failed",
        "key": "npm run check",
        "at": {
          "entry": 11,
          "ts": "2026-01-01T00:00:11.000Z"
        },
        "attrs": {
          "last_error_class": "unknown",
          "runs": 1
        },
        "evidence": [
          {
            "line": 12,
            "sha256": "sha256:b5f2c56cf618824caacd336db52a3c477d99cb3d01c15d78a8b1457fba00b83a"
          },
          {
            "line": 13,
            "sha256": "sha256:8b107ba50cc1206538b6d1c38bc18d4e96c240f2193baf5413d9f5e73afaa162"
          }
        ],
        "snippet": "Run npm check script (expected to fail, no package.json yet)",
        "unbacked": false
      },
      {
        "kind": "cmd.run",
        "key": "ls -la .",
        "at": {
          "entry": 6,
          "ts": "2026-01-01T00:00:06.000Z"
        },
        "attrs": {
          "failed": false,
          "runs": 1
        },
        "evidence": [
          {
            "line": 7,
            "sha256": "sha256:4eb13fc037447fccf2d211a9435dff14d2728c0e28481bee772169567b53327a"
          },
          {
            "line": 8,
            "sha256": "sha256:c9787b2bca2cc7d07bcfe33e41275573e96c5445c3e9e383d67304f7e9399987"
          }
        ],
        "snippet": "List directory contents",
        "unbacked": false
      },
      {
        "kind": "cmd.run",
        "key": "npm run check",
        "at": {
          "entry": 15,
          "ts": "2026-01-01T00:00:15.000Z"
        },
        "attrs": {
          "failed": false,
          "runs": 1
        },
        "evidence": [
          {
            "line": 16,
            "sha256": "sha256:45b615e82ed9c60625472b5a7624777db11fa13c32bda37bc77956b8695dd80a"
          },
          {
            "line": 17,
            "sha256": "sha256:4bd660a40319c91462aa92ffa39b54be58ea694e102612ac02615ddea4810a32"
          }
        ],
        "snippet": "Run npm check script",
        "unbacked": false
      },
      {
        "kind": "file.read",
        "key": "notes.md",
        "scope": "cwd",
        "at": {
          "entry": 4,
          "ts": "2026-01-01T00:00:04.000Z"
        },
        "attrs": {
          "reads": 1
        },
        "evidence": [
          {
            "line": 5,
            "sha256": "sha256:03da6353499c7bc0c822e2c36e603d30b061ebdf8f1682cbafddf42d1017f002"
          },
          {
            "line": 6,
            "sha256": "sha256:3eb801212a0c1bba8ee9f1df5e2f55a88a650883ded90a58b48f67eb85e3af75"
          }
        ],
        "snippet": "Read notes.md",
        "unbacked": false
      }
    ],
    "counters": {
      "facts": 9,
      "by_kind": {
        "decision.stated": 1,
        "error.raised": 1,
        "error.fixed": 1,
        "file.modified": 2,
        "cmd.failed": 1,
        "cmd.run": 2,
        "file.read": 1
      },
      "source_entries": 8,
      "source_tool_calls": 7,
      "unmapped_tool_calls": 0,
      "coverage_ppm": 1000000,
      "external_path_count": 0
    },
    "git": null,
    "plan": null,
    "path_base": "cwd",
    "version": 1
  },
  "payload_hash": "sha256:1ebd2c27a646e226e18229a76828f90e658795c30b8db22f23618777eaba16c4",
  "coverage": {
    "source_tool_calls": 7,
    "unmapped_tool_calls": 0,
    "coverage_ppm": 1000000,
    "unmapped_by_tool": {}
  },
  "diagnostics": [],
  "degraded": []
}
```
<!-- demo-json:end -->

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
