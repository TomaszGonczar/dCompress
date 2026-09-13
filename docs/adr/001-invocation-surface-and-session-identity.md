# ADR 001 — Invocation surface and session identity

**Status:** Accepted
**Date:** 2026-09-13
**Deciders:** Operator
**Supersedes:** nothing
**Affects:** CONCEPT §7, §8; SCHEMA §2; issues OG-55…OG-71

## Context

An early version of the plan assumed dcompact would be driven by a bare terminal command: the
user types `dcompact snapshot`, or a hook shells out to it. Working from inside a coding
agent — which is where the user actually is when they want this — that model breaks in two
ways:

1. **A bare CLI cannot know which session it belongs to.** Several agent sessions run at once
   (multiple terminals, multiple projects, subagents). `dcompact snapshot` with no argument
   would have to guess, and every guess is wrong: newest-by-mtime picks whichever session
   wrote last, and "all of them" is not what the user asked for.
2. **A terminal command is the wrong affordance.** The user is inside the agent's TUI. Asking
   them to leave it, run a command, and come back is worse than the `/compact` they already
   have. The tool has to appear *inside* the agent, as something they invoke in place.

The requirement, stated plainly: the user works inside their coding agent; the tool must be
reachable there, must act on **their** session, and must not silently act on anyone else's.

## Decision

### 1. dcompact never guesses a session. Identity is supplied, or the command fails.

There is no fallback lookup, no "most recent", no "all sessions". When the session is unknown,
the command exits 2 with the list of candidate sessions and the flag to disambiguate.

This is a hard rule because the failure mode is silent and destructive in the wrong
direction: snapshotting the wrong session produces a plausible-looking artifact about someone
else's work, and the user has no way to tell.

### 2. Invocation happens through the agent's own surface, in two tiers.

**Tier A — identity-carrying channels (preferred).** The host agent launches dcompact in a
context that already names the session:

| Agent | Channel | Identity source | Verified |
|---|---|---|---|
| Claude Code | MCP server (stdio) | `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR` env | ✅ measured: 106 env vars, session id → exact transcript at `~/.claude/projects/<slug>/<sid>.jsonl` |
| Claude Code | `~/.claude/commands/*.md` | none — the .md must pass the id as `$ARGUMENTS` | ✅ mechanism verified |
| OMP | in-process extension | `ctx.sessionManager.getSessionId()` | ✅ verified in binary (`getSessionId` present); **MCP is not sufficient** — OMP passes only 14 env vars to MCP children, with no session id |
| Codex | hooks / prompts | TBD in P4 | ⚠️ unverified |

**Tier B — no identity (degraded).** A bare terminal invocation carries no session. It must be
given one explicitly:

```bash
dcompact snapshot --session <id>        # explicit
dcompact snapshot --transcript <path>   # explicit, agent-agnostic
dcompact snapshot                        # ERROR: lists candidates, exits 2
```

Tier B is fully supported — it is what the tests and CI use — but it is never *automatic*.

### 3. The invocation surface is a first-class deliverable, not a wrapper.

Each supported agent gets, in this order of preference:

1. **A slash command inside the agent** (`/dcompact:restore`, `/dcompact:snapshot`) — the user
   never leaves the TUI. This is the primary affordance and it must not be a replacement for
   `/compact`, only an addition beside it.
2. **A native tool / MCP tool** the model can call, for the same operations.
3. **A terminal binary** for scripting, CI, and agents with no integration.

The terminal binary is the *last* of the three, not the first.

## Consequences

### Positive

- The "which session?" question is answered by the only party that knows: the agent.
- No ambiguity to get wrong, because an unknown session is an error rather than a guess.
- The user stays in their TUI, which is where the problem occurs.
- `/compact` is untouched. dcompact sits beside it.

### Negative / accepted risks

- **More surface to build.** Each agent needs a command, not just a hook: Claude gets an MCP
  server plus a `.md` command, OMP gets a native extension, Codex gets whatever P4 finds.
  This is real work and it is why the invocation surface is its own phase, not a footnote.
- **OMP cannot use MCP for this.** Measured: OMP hands MCP children 14 env vars and no session
  identifier. The OMP integration must be an in-process extension, which is a different
  artifact from the MCP server and must be maintained separately.
- **Tier B is a poor experience**, deliberately. A bare `dcompact snapshot` that worked by
  guessing would be worse than one that refuses.

### Neutral

- MCP remains valuable for reach (nine agents) but is explicitly **pull, not push** — it
  cannot deliver continuity, only on-demand recall. That distinction is unchanged; this ADR
  only concerns *how dcompact is invoked and how it learns its session*, not what it does
  afterwards.

## Open questions this ADR does not settle

1. Codex's identity channel (P4). If Codex passes a session id to MCP or hooks, it joins
   Tier A; if not, it takes the `.md`-command-with-`$ARGUMENTS` route.
2. Whether Claude's `.md` commands can read `CLAUDE_CODE_SESSION_ID` from the shell at
   expansion time, which would let a plain command reach Tier A without MCP.
3. Whether the slash command should be namespaced (`/dcompact:restore`) or bare
   (`/dcompact`). Namespacing avoids collisions with the agent's built-ins; bare is shorter.
   Leaning namespaced, decided in the phase that implements it.

## Evidence

Measured on this machine, 2026-09-13:

```
# Claude Code MCP child process environment
CLAUDE_CODE_SESSION_ID=3d496ed2-36fb-442b-8e33-5f725ad22beb
CLAUDE_PROJECT_DIR=/private/tmp/mcp-probe
CLAUDE_CODE_ENTRYPOINT=sdk-cli
→ resolves to /Users/…/.claude/projects/-private-tmp-mcp-probe/3d496ed2-….jsonl (24 lines)

# OMP MCP child process environment
cwd=/home/agent/work
total env vars: 14      (no session identifier)
→ OMP must use an in-process extension instead
```
