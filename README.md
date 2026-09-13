# dcompact

**Portfolio #1 — a deterministic session continuity tool.**

Deterministic session continuity for coding agents.

Coding agents lose work context when they compact, restart, or time out. `dcompact`
records what actually happened in a session — files touched, commands run, errors
raised and resolved, decisions stated, git state — as hash-addressed snapshots
extracted from the agent's own transcript by rules, not by an LLM. The newest snapshot
is injected back into the agent after a compaction or on resume, so the session keeps
working from verified facts instead of a lossy prose summary.

- No network. No account. No server. Local files only.
- No LLM in the extraction path. Same transcript in, same bytes out.
- Reversible install. Every file it edits is backed up and restored byte-identical.

**Status: design phase.** No code yet. Read the design before contributing.

- [`docs/CONCEPT.md`](docs/CONCEPT.md) — problem, architecture, agent integration, security model
- [`docs/SCHEMA.md`](docs/SCHEMA.md) — snapshot format and the canonicalization rules that make hashes reproducible
- [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md) — phases P0–P13, exit criteria, test strategy, collateral and bug policy

## One command, conceptually

```bash
dcompact install --agent claude    # rewrites hooks behind markers, backs up first
dcompact snapshot                  # extract facts from the current session transcript
dcompact verify --all              # recompute every stored hash
dcompact restore --latest          # print the pack that gets injected after compaction
dcompact doctor                    # what works, what is degraded, what changed on disk
dcompact uninstall --agent claude  # restore the original config files
```

## License

MIT (to be confirmed in P0).
