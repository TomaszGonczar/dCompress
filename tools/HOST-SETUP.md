# Host setup — one-time, before the first autonomous run

Everything here is done **once** on the host. After this, `tools/agent-run` handles the rest.

## 0. Prerequisites

```bash
docker --version          # Docker Desktop or OrbStack must be running
gh auth status            # must be authenticated
jq --version              # used by tools/linear
```

## 1. GitHub scopes

Current scopes are `gist`, `read:org`, `repo`. Two are missing:

| Scope | Needed for | Blocks |
|---|---|---|
| `workflow` | pushing `.github/workflows/*` | issue 17 (P13 Release) — the entire CI setup |
| `user` | reading your verified emails | nothing critical; nice to have |

Add them once:

```bash
gh auth refresh -h github.com -s workflow,user
```

This opens a browser for the OAuth round-trip. Skip it until you reach issue 17 if you prefer —
nothing before that needs it.

## 2. Linear credential

`tools/linear` reads `LINEAR_API_KEY` from the environment, from `.env` in the repo root, or
from `~/.dcompact-agent.env`. It also requires `DCOMPACT_LINEAR_PROJECT`, the id of the Linear
project to operate on — that id is workspace-specific and is deliberately not committed, so the
tool refuses with exit 2 rather than guessing.

Only `LINEAR_API_KEY` is read from the files above. `DCOMPACT_LINEAR_PROJECT` **must come from
the environment** each time you invoke the tool; it is not read from `.env` or
`~/.dcompact-agent.env`, so exporting it in a shell profile or per invocation is what makes it
available. Write both to the host file for your own reference, but export the project id
explicitly:

```bash
{
  printf 'LINEAR_API_KEY=%s\n' '<your-key>'
  printf 'DCOMPACT_LINEAR_PROJECT=%s\n' '<your-linear-project-id>'
} >> ~/.dcompact-agent.env
chmod 600 ~/.dcompact-agent.env
```

Verify. The key is picked up from the file; the project id is passed through the environment:

```bash
export LINEAR_API_KEY=$(grep '^LINEAR_API_KEY=' ~/.dcompact-agent.env | cut -d= -f2-)
export DCOMPACT_LINEAR_PROJECT=<your-linear-project-id>
cd <repo> && ./tools/linear next
# → OG-55	01 · P0 — Foundation
```

To load both into the current shell without exporting them individually, source the file —
`set -a; . ~/.dcompact-agent.env; set +a`.

## 3. Agent credentials

The sandbox has **no** access to `~/.claude`, `~/.codex`, `~/.omp`, or `~/.gemini`. Each agent
gets a minimal, purpose-built credential directory instead.

### Codex (uses ChatGPT OAuth — no API key)

```bash
~/.dcompact-agent/setup-codex-home.sh
```

Creates `~/.dcompact-agent/codex-home/` containing only `auth.json` and a minimal
`config.toml`. It deliberately excludes MCP servers, plugins, and history — nothing that could
carry host state into the sandbox. Re-run it if the Codex token expires.

### OMP (needs a provider API key, since it has no equivalent of a host OAuth file)

Create `~/.dcompact-agent/omp.env`:

```bash
cat > ~/.dcompact-agent/omp.env <<'EOF'
OPENROUTER_API_KEY=sk-or-...
EOF
chmod 600 ~/.dcompact-agent/omp.env
```

Copy the key value from wherever your provider keys are stored on the host. OMP reads provider
keys from the environment; the sandbox cannot see the host's OMP profile or its `agent.db`.

Test that OMP authenticates inside the sandbox before a real run:

```bash
docker run --rm --env-file ~/.dcompact-agent/omp.env dcompact-sandbox:latest \
  bash -lc 'omp -p --auto-approve "Reply with exactly: OMP_SANDBOX_OK"'
```

## 4. Build the sandbox image

```bash
cd <repo>
docker build -t dcompact-sandbox:latest tools/sandbox
```

`tools/agent-run` builds it automatically on first use, so this is optional — but doing it
once explicitly surfaces network or arch problems before you are mid-run.

## 5. Verify isolation

This is the check that matters. Inside the sandbox, the host's agent configs must not exist:

```bash
docker run --rm dcompact-sandbox:latest bash -lc \
  'for p in ~/.claude ~/.codex ~/.omp ~/.gemini; do
     [ -e "$p" ] && echo "PRESENT(!!) $p" || echo "absent  $p"; done'
```

Expected: four `absent` lines. If anything shows `PRESENT`, stop — the mount is wrong and the
agent could rewrite your live configuration.

## 6. Prepare a task (this is the normal path)

`tools/agent-run` **prepares** by default. It branches, writes the full task brief, updates
Linear, and stops — printing the command to run. Nothing executes a model unless you pass
`--execute`.

```bash
cd <repo>
./tools/agent-run OG-55 --dry-run     # inspect the plan, touch nothing
./tools/agent-run OG-55               # prepare: branch + brief + Linear update
```

That leaves you with:

```
.agent-task/prompt.md   the complete task brief (invariants, docs, issue body, rules)
.agent-task/run.sh      the exact sandbox command, self-contained and readable
```

Either hand `run.sh` to a working agent with a stronger model, or run it yourself:

```bash
./.agent-task/run.sh                  # run the prepared command
./tools/agent-run OG-55 --execute     # same, via the wrapper (adds commit/push/PR)
```

To abandon a prepared task:

```bash
git switch main && git branch -D issue/og-55-01-p0-foundation
rm -rf .agent-task
./tools/linear status OG-55           # reset to Backlog in Linear if needed
```

## 7. Review loop (after an --execute run)

```bash
gh pr view --web                      # read the diff
gh pr merge --squash --delete-branch  # when satisfied
./tools/linear done OG-55             # close the issue
./tools/agent-run --next              # prepare the next issue in order
```

## What the sandbox does and does not protect

**Protected:** host agent configs (`~/.claude`, `~/.codex`, `~/.omp`, `~/.gemini`); host
filesystem outside the bind-mounted repo; host processes; other repositories.

**Credential scope — deliberate:** the container receives **no** `GH_TOKEN` and **no**
`LINEAR_API_KEY`. The agent only edits files; the host performs the commit, push, PR and
Linear updates afterwards. `GH_TOKEN` carries `repo` scope across every repository on the
account, so passing it into the sandbox would defeat the isolation the sandbox exists for.

The one exception is OMP, which needs its own model-provider key to run at all — mounted via
`--env-file ~/.dcompact-agent/omp.env`. That key is provider-scoped and cannot reach GitHub
or Linear. Codex needs no such key (it uses the mounted ChatGPT OAuth home).

**Not protected:** the repository itself (that is the point — the agent edits it).

**Enforcement note:** branch protection is unavailable on private repos without GitHub Pro.
The gate is therefore procedural: `agent-run` never merges, and you review every PR.

**Network:** the sandbox has network access because it must reach npm and the model API.
For a no-network profile on pure-logic phases, a gVisor-based sandbox pattern is the reference.
