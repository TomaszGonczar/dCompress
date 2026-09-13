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
from `~/.dcompact-agent.env`. Create the host file so it is available outside the repo:

```bash
grep '^LINEAR_API_KEY=' ~/Omega-v3/.env >> ~/.dcompact-agent.env
chmod 600 ~/.dcompact-agent.env
```

Verify:

```bash
export LINEAR_API_KEY=$(grep '^LINEAR_API_KEY=' ~/.dcompact-agent.env | cut -d= -f2-)
cd ~/Projects/dcompact && ./tools/linear next
# → OG-55	01 · P0 — Foundation
```

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

Copy the key value from `~/Omega-v3/.env`. OMP reads provider keys from the environment; the
sandbox cannot see the host's OMP profile or its `agent.db`.

Test that OMP authenticates inside the sandbox before a real run:

```bash
docker run --rm --env-file ~/.dcompact-agent/omp.env dcompact-sandbox:latest \
  bash -lc 'omp -p --auto-approve "Reply with exactly: OMP_SANDBOX_OK"'
```

## 4. Build the sandbox image

```bash
cd ~/Projects/dcompact
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

## 6. First run

```bash
cd ~/Projects/dcompact
./tools/agent-run OG-55 --dry-run     # inspect the plan, change nothing
./tools/agent-run OG-55               # the real thing
```

The runner branches, moves the Linear issue to In Progress, runs the agent in the sandbox,
then commits, pushes, and opens a PR. It never merges.

## 7. Review loop

```bash
gh pr view --web                      # read the diff
gh pr merge --squash --delete-branch  # when satisfied
./tools/linear done OG-55             # close the issue
./tools/agent-run --next              # next issue in order
```

## What the sandbox does and does not protect

**Protected:** host agent configs (`~/.claude`, `~/.codex`, `~/.omp`, `~/.gemini`); host
filesystem outside the bind-mounted repo; host processes; other repositories.

**Not protected:** the repository itself (that is the point — the agent edits it); the GitHub
token you pass in (`repo` scope, so it can push branches); the Linear key (so it can update
issues). The agent cannot merge, because branch protection is not available on private repos
without GitHub Pro — **the process enforces it instead**: `agent-run` never merges, and you
review every PR.

**Note on `--network bridge`:** the sandbox has network access because it needs to reach
npm, GitHub, and the model API. If you later want a no-network profile for pure-Python
phases, your `Omega-v3/core/sandbox.py` gVisor pattern is the reference.
