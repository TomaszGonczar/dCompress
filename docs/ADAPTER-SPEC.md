# Adapter specification — Claude Code, Codex, and OMP

This is the OG-59 adapter contract for the three supported agents. Every statement about
agent behavior is marked with exactly one evidence marker; transcript, configuration, and
issue text are treated as untrusted data. [observed:<repo>/docs/briefs/OMP-BATCH-2.md]

## 1. Shared contract and Wave 1 rulings

An adapter locates and reads the agent transcript, maps declared record shapes to the
normalized event stream, and describes configuration installation/removal; extraction stays
rule-based and the core remains pure. [docs:https://github.com/TomaszGonczar/dcompact/blob/main/docs/CONCEPT.md]

The payload contains only transcript-derived values and explicit extraction inputs; canonical
payload bytes and their SHA-256 hash are deterministic, while clock, host, and absolute
transcript location remain envelope data. [docs:https://github.com/TomaszGonczar/dcompact/blob/main/docs/SCHEMA.md]

Evidence is exactly `{line, sha256}` and the transcript path occurs once in the envelope;
external file facts survive as `<opaque scope id>:<basename>` with `scope: "external"`, never
with host path text. [observed:<repo>/docs/briefs/OMP-BATCH-2.md]

Scope roots are derived only from transcript evidence (session cwd, cwd changes, explicit
grants, and command-named roots); adapters must not probe the filesystem to decide scope.
[observed:<repo>/docs/briefs/OMP-BATCH-2.md]

Unknown record shapes produce `degraded: schema-drift`, or `degraded: extraction-empty` when a
non-empty recognized transcript yields no facts; a recognized but unmapped tool increments
`unmapped_tool_calls`, lowers `coverage_ppm`, and adds no degraded state. [docs:https://github.com/TomaszGonczar/dcompact/blob/main/docs/CONCEPT.md]

The engine must not assume an exit-code field: where a result has an error flag, that flag is
the success/failure signal, and adapter mappings define richer result metadata. [observed:<repo>/docs/briefs/OMP-BATCH-2.md]

No adapter may guess a session: absent identity must refuse selection, show candidates, and
require explicit `--session <id>` or `--transcript <path>`. [observed:<repo>/docs/briefs/OMP-BATCH-2.md]

Installed hooks must exit zero on internal failure and report a finite degraded/unavailable
state, and installation must never replace the agent's native `/compact`. [docs:https://github.com/TomaszGonczar/dcompact/blob/main/docs/CONCEPT.md]

## 2. Claude Code adapter

### Configuration, version, and installation

User settings are `~/.claude/settings.json`; shared and local project settings are
`.claude/settings.json` and `.claude/settings.local.json`; managed settings are supplied by
the organization. [docs:https://code.claude.com/docs/en/settings]

Effective precedence is managed, command-line/session overrides, project-local, shared
project, then user settings; `--settings` is above project/user files but below managed
settings, and hook lists merge across levels. [docs:https://code.claude.com/docs/en/settings]

`CLAUDE_CONFIG_DIR` relocates the Claude data directory, including settings, session history,
and plugins. [docs:https://code.claude.com/docs/en/settings]

The adapter detects the CLI with `claude --version` or `claude -v`. [docs:https://code.claude.com/docs/en/cli-reference]
The recon installation reported `2.1.238 (Claude Code)`. [observed:claude --version|claude -v]

Relevant documented gates are `prompt_id` from 2.1.196, comma matchers from 2.1.191,
hyphenated exact matchers from 2.1.195, `PostModelSwitch` from 2.1.251, and `scratchpad_dir`
from 2.1.257; therefore the installed 2.1.238 adapter must not require the latter two.
[docs:https://code.claude.com/docs/en/hooks]

The installer may add command-hook entries to the applicable settings file, must back up
before editing, and must preserve/uninstall its managed region reversibly. [docs:https://github.com/TomaszGonczar/dcompact/blob/main/docs/CONCEPT.md]

### Registered events and exact input/output

The Claude adapter registers only `SessionStart` (matcher `resume|compact|startup`) and
`PostCompact` (matcher `manual|auto`). The broader event inventory below is reference-only and
is not an implementation input. [docs:https://code.claude.com/docs/en/hooks]

The selected input contracts are complete at the top level:

| Event | Field | Type | Required | Meaning | Evidence |
|---|---|---|---|---|---|
| SessionStart | `session_id` | string | yes | session identity | [docs:https://code.claude.com/docs/en/hooks] |
| SessionStart | `transcript_path` | string | yes | JSONL transcript location | [docs:https://code.claude.com/docs/en/hooks] |
| SessionStart | `cwd` | string | yes | event working directory | [docs:https://code.claude.com/docs/en/hooks] |
| SessionStart | `hook_event_name` | literal `"SessionStart"` | yes | discriminator | [docs:https://code.claude.com/docs/en/hooks] |
| SessionStart | `source` | enum `startup\|resume\|clear\|compact\|fork` | yes | start reason | [docs:https://code.claude.com/docs/en/hooks] |
| SessionStart | `model` | string | no | selected model | [docs:https://code.claude.com/docs/en/hooks] |
| SessionStart | `agent_type` | string | no | agent kind | [docs:https://code.claude.com/docs/en/hooks] |
| PostCompact | `session_id` | string | yes | session identity | [docs:https://code.claude.com/docs/en/hooks] |
| PostCompact | `transcript_path` | string | yes | JSONL transcript location | [docs:https://code.claude.com/docs/en/hooks] |
| PostCompact | `cwd` | string | yes | event working directory | [docs:https://code.claude.com/docs/en/hooks] |
| PostCompact | `hook_event_name` | literal `"PostCompact"` | yes | discriminator | [docs:https://code.claude.com/docs/en/hooks] |
| PostCompact | `trigger` | enum `manual\|auto` | yes | compaction reason | [docs:https://code.claude.com/docs/en/hooks] |
| PostCompact | `compact_summary` | string | yes | generated summary | [docs:https://code.claude.com/docs/en/hooks] |

SessionStart output is `{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:string}}`;
the adapter emits bounded context and does not block. PostCompact output is ignored: it cannot
block or inject context, and its side effect is recording the supplied summary. [docs:https://code.claude.com/docs/en/hooks]

Three isolated `startup` probes against the installed 2.1.238 CLI produced the same sorted
top-level fields — `cwd`, `hook_event_name`, `session_id`, `source`, and `transcript_path` —
with their documented string types. Each stdin object was 278 raw bytes, the hook exited `0`,
and Claude accepted its structured `SessionStart.additionalContext` output before the isolated
profile stopped at the API login boundary. [observed:claude-sessionstart-disposable-probe-2026-09-13]

#### Reference-only documented event inventory

Claude command hooks receive one JSON object on stdin; HTTP hooks receive the same object as
the POST body. [docs:https://code.claude.com/docs/en/hooks]

Every relevant hook input includes `session_id`, `transcript_path`, `cwd`, and
`hook_event_name`; common optional fields include `prompt_id`, `scratchpad_dir`,
`permission_mode`, model, and agent fields. [docs:https://code.claude.com/docs/en/hooks]

`SessionStart` matches `source` values `startup`, `resume`, `clear`, `compact`, or `fork`, and
may receive `model` and `agent_type`; its restore output is
`hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: "..."}`. [docs:https://code.claude.com/docs/en/hooks]

`UserPromptSubmit` can return `hookSpecificOutput.additionalContext` beside the prompt but
cannot replace the submitted prompt. [docs:https://code.claude.com/docs/en/hooks]

`PreToolUse` matches `tool_name` and receives `tool_name`, arbitrary `tool_input`, and
`tool_use_id`; output may contain `permissionDecision`, its reason, `updatedInput`, and
`additionalContext` under `hookSpecificOutput`. [docs:https://code.claude.com/docs/en/hooks]

`PostToolUse` matches `tool_name`, receives completed input/result, and may return
`additionalContext` or `updatedToolOutput`, but cannot undo execution. [docs:https://code.claude.com/docs/en/hooks]

`PostToolUseFailure` matches `tool_name` and adds `error`, optional `is_interrupt`, and
optional `duration_ms`; validation rejection and permission denial do not emit it. [docs:https://code.claude.com/docs/en/hooks]

`PreCompact` matches `manual|auto` and receives `{trigger, custom_instructions}`; manual
instructions may be null and auto instructions are null. [docs:https://code.claude.com/docs/en/hooks]
Dcompact must never block compaction. [docs:https://github.com/TomaszGonczar/dcompact/blob/main/docs/CONCEPT.md]

`PostCompact` matches `manual|auto` and receives `{trigger, compact_summary}`; it is
side-effect-only and cannot inject restore context. [docs:https://code.claude.com/docs/en/hooks]

`SessionEnd` matches `clear|resume|logout|prompt_input_exit|other` and receives `{reason}`;
termination cannot be blocked and ordinary output is discarded. [docs:https://code.claude.com/docs/en/hooks]

Matcher `*`, empty, or omitted means all; exact names use `|` or current comma separators,
and other matcher text is an unanchored JavaScript regular expression. [docs:https://code.claude.com/docs/en/hooks]

Command-hook exit 0 is success, exit 2 can block only on a blocking event, and other nonzero
exits are generally non-blocking errors; structured JSON is emitted on stdout. [docs:https://code.claude.com/docs/en/hooks]

The critical restore path is `SessionStart` with `source: "resume"` or `source: "compact"`,
returning bounded `hookSpecificOutput.additionalContext`; context is inserted as a system
reminder at the event point, not as a chat message. [docs:https://code.claude.com/docs/en/hooks]

Claude writes additional context over 10,000 characters to a session-directory file with a
short preview/path, so dcompact output must remain bounded. [docs:https://code.claude.com/docs/en/hooks]

### Identity, transcript, and normalization

The authoritative identity is hook `session_id`; `transcript_path` is the supplied transcript
location, and dcompact must use these values or explicit CLI identity. [docs:https://code.claude.com/docs/en/hooks]

When identity is absent, Claude adapter behavior is refusal with candidate sessions and an
explicit `--session` or `--transcript` next step; it must never choose `--continue`/most recent
implicitly. [observed:<repo>/docs/briefs/OMP-BATCH-2.md]

The transcript is JSONL under redacted Claude project session storage, with one JSON object per
physical line; the local sample had 12 files, 6,672 records, and 16,618,025 bytes. [observed:<user>/.claude/projects/*.jsonl]

Observed top-level record types include `assistant`, `user`, `system`, `attachment`,
`file-history-snapshot`, `file-history-delta`, `queue-operation`, `mode`, `permission-mode`,
`last-prompt`, `custom-title`, and `ai-title`; unknown/non-conversational variants are ignored
or marked schema drift rather than guessed. [observed:<user>/.claude/projects/*.jsonl]

Conversation records commonly carry `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`,
`version`, `gitBranch`, and `isSidechain`; user tool results may carry
`sourceToolAssistantUUID`. [observed:<user>/.claude/projects/*.jsonl]

Tool calls are nested assistant `content` blocks with `{type:"tool_use", id, name, input,
caller}`; results are user `content` blocks with `{type:"tool_result", tool_use_id, content,
is_error?}`. [observed:<user>/.claude/projects/*.jsonl]

Call/result pairing uses `tool_use.id` ↔ `tool_result.tool_use_id`, not line adjacency; raw-byte
line numbers and byte offsets are measured before JSON parsing. [observed:<user>/.claude/projects/*.jsonl]
Asynchronous transcript lag may omit the newest hook-event messages. [docs:https://code.claude.com/docs/en/hooks]

The adapter maps only exact observed names and uses result error metadata when present; it
must not infer a universal vocabulary from another agent. [observed:<user>/.claude/projects/*.jsonl]

### Claude observed vocabulary

Counts below are nested `tool_use.name` counts across 12 local project JSONL files and 1,426
tool-use blocks. [observed:<user>/.claude/projects/*.jsonl]

| Name | Count |
|---|---:|
| `Bash` | 897 [observed:<user>/.claude/projects/*.jsonl] |
| `Read` | 137 [observed:<user>/.claude/projects/*.jsonl] |
| `Edit` | 127 [observed:<user>/.claude/projects/*.jsonl] |
| `TaskUpdate` | 93 [observed:<user>/.claude/projects/*.jsonl] |
| `TaskCreate` | 56 [observed:<user>/.claude/projects/*.jsonl] |
| `Write` | 45 [observed:<user>/.claude/projects/*.jsonl] |
| `AskUserQuestion` | 23 [observed:<user>/.claude/projects/*.jsonl] |
| `ToolSearch` | 16 [observed:<user>/.claude/projects/*.jsonl] |
| `Agent` | 10 [observed:<user>/.claude/projects/*.jsonl] |
| `WebFetch` | 5 [observed:<user>/.claude/projects/*.jsonl] |
| `ListAgents` | 3 [observed:<user>/.claude/projects/*.jsonl] |
| `Artifact` | 3 [observed:<user>/.claude/projects/*.jsonl] |
| `mcp__linear__linear_list_projects` | 2 [observed:<user>/.claude/projects/*.jsonl] |
| `mcp__probe__probe_env`, `mcp__firecrawl__firecrawl_scrape`, `mcp__codebase-memory-mcp__index_status`, `mcp__claude_ai_Linear__list_projects`, `mcp__claude_ai_Linear__get_project`, `TaskList`, `Skill`, `ScheduleWakeup`, `ExitPlanMode` | 1 each [observed:<user>/.claude/projects/*.jsonl] |

### Failure, timeout, trust, and unsupported behavior

Hook timeout cancels the hook and discards output; a timed-out command/HTTP/MCP hook does not
block a Claude `PreToolUse` call. [docs:https://code.claude.com/docs/en/hooks]

`SessionEnd` defaults to 1.5 seconds with an overall configured budget capped at 60 seconds;
missing/non-executable commands are generally non-blocking errors. [docs:https://code.claude.com/docs/en/hooks]

Workspace trust controls repository settings hooks, and managed policy may restrict hooks via
`allowManagedHooksOnly`; dcompact reports unavailable/degraded capture rather than guessing.
[docs:https://code.claude.com/docs/en/hooks]

Transcript prompt/tool text and injected context are untrusted data and must never be executed,
evaluated, or interpolated into shell commands. [observed:<user>/.claude/projects/*.jsonl]

## 3. Codex adapter

### Configuration and version

Codex user config is `${CODEX_HOME}/config.toml` (default redacted home `.codex/config.toml`);
project config is `.codex/config.toml` in trusted project layers; hooks are in
`${CODEX_HOME}/hooks.json`. [observed:<USER>/.codex/hooks.json]
Codex also documents hook tables in config. [docs:https://github.com/openai/codex/blob/main/codex-rs/config/src/loader/README.md]

Precedence from low to high is packaged defaults, system, enterprise/cloud-managed, user,
profile, project layers, `-c/--config` session flags, and legacy managed compatibility layers.
[docs:https://github.com/openai/codex/blob/main/codex-rs/config/src/loader/README.md]

Project layers collect cwd/parent/repository `.codex/config.toml` files and are disabled for an
untrusted project. [docs:https://github.com/openai/codex/blob/main/codex-rs/config/src/loader/mod.rs]

The adapter probes `codex --version`; the local installation reported `codex-cli 0.154.0`, and
rollout `session_meta.payload.cli_version` is a per-session version field. [observed:codex --version; <USER>/.codex/version.json; <USER>/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl]

### Registered event and exact payload/output

The Codex adapter registers only `SessionStart`; all other events in the first-party inventory
are reference-only and are not implementation inputs for this adapter. [observed:<USER>/.codex/hooks.json]

| Event | Field | Type | Required | Meaning | Evidence |
|---|---|---|---|---|---|
| SessionStart | `session_id` | string | yes | session identity | [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-start.command.input.schema.json] |
| SessionStart | `transcript_path` | string or null | yes | rollout location, when supplied | [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-start.command.input.schema.json] |
| SessionStart | `cwd` | string | yes | event working directory | [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-start.command.input.schema.json] |
| SessionStart | `hook_event_name` | literal `"SessionStart"` | yes | discriminator | [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-start.command.input.schema.json] |
| SessionStart | `model` | string | yes | selected model | [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-start.command.input.schema.json] |
| SessionStart | `permission_mode` | string | yes | permission mode | [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-start.command.input.schema.json] |
| SessionStart | `source` | enum `startup\|resume\|clear\|compact\|fork` | yes | start reason | [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-start.command.input.schema.json] |

SessionStart output permits `continue`, `stopReason`, `suppressOutput`, `systemMessage`, and
`hookSpecificOutput:{hookEventName:"SessionStart",additionalContext?:string}`; dcompact returns
bounded `additionalContext`, does not block, and records only as a side effect. [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-start.command.output.schema.json]

The adapter does not register PostCompact, SessionEnd, tool, permission, prompt, stop, or
subagent events; their schemas and the observed rollout inner records remain non-input inventory.
[observed:<USER>/.codex/hooks.json]

#### Reference-only documented event inventory

Codex declares `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, and `Stop`.
[docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/src/lib.rs]

Matchers apply to tool, permission, compaction, session-start/end, and subagent discriminators;
events without such a discriminator ignore matcher semantics. [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/src/lib.rs]

Command hooks receive one JSON object on stdin and may emit one JSON object on stdout; generated
schemas reject unknown top-level properties. [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/src/schema.rs]

`SessionStart` requires `session_id`, nullable/string `transcript_path`, `cwd`,
`hook_event_name:"SessionStart"`, `model`, `permission_mode`, and `source` in
`startup|resume|clear|compact|fork`. [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-start.command.input.schema.json]
Its output supports `continue`, `stopReason`, `suppressOutput`, `systemMessage`, and
`hookSpecificOutput` with `additionalContext`. [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-start.command.output.schema.json]

`SessionEnd` requires `session_id`, nullable `transcript_path`, `cwd`,
`hook_event_name:"SessionEnd"`, and `reason`. [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-end.command.input.schema.json]

`PreToolUse` requires session/turn identity, nullable transcript path, cwd, event name, model,
permission mode, `tool_name`, arbitrary `tool_input`, and `tool_use_id`; optional `agent_id` and
`agent_type` identify subagents. [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json]

`PostToolUse` adds `tool_response`; its output can carry a block decision, updated MCP output,
or `additionalContext`. [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/post-tool-use.command.output.schema.json]
`PreToolUse` can return approve/block and permission/input updates. [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/pre-tool-use.command.output.schema.json]

Command hooks are the supported direct form; prompt/agent/HTTP and async forms are skipped or
unsupported, with HTTP requiring a wrapper command. [docs:https://github.com/openai/skills/blob/main/skills/.curated/migrate-to-codex/references/differences.md]

### Identity, rollout, and normalization

The hook `session_id` is the identity source. [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-start.command.input.schema.json]
It is corroborated by `session_meta.payload.session_id` in sampled rollouts. [observed:<USER>/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl]
The adapter must refuse absent identity and require explicit session/transcript selection. [observed:<repo>/docs/briefs/OMP-BATCH-2.md]

Rollouts are JSONL at redacted `${CODEX_HOME}/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`;
each physical line has `{timestamp, ordinal, type, payload}`, with sampled ordinals starting at
zero and increasing by one. [observed:<USER>/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl; anonymized 30-file sample]

A representative 76-line rollout was 444,237 bytes, so line number is not a byte offset; parse
complete raw lines and hash raw-line bytes for evidence. [observed:<USER>/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl; anonymized measurement]

The 30-file sample contained 6,725 records and 37,076,240 bytes, all sharing the envelope shape.
[observed:<USER>/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl; anonymized 30-file measurement]

`response_item` occurred 2,713 times with inner types `message`, `reasoning`, `custom_tool_call`,
`custom_tool_call_output`, `agent_message`, `function_call`, and `function_call_output`.
[observed:<USER>/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl; anonymized 30-file frequency count]

Tool calls use `custom_tool_call` fields `id`, `call_id`, `name`, `input`, `status`; outputs use
`custom_tool_call_output` fields `id`, `call_id`, `output`; function calls use `id`, `call_id`,
`name`, `arguments`, optional `namespace`, and outputs link by `call_id`. [observed:<USER>/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl; anonymized schema inventory]

The stable observed links are `id` and `call_id`; no `response_id`, `previous_id`, or `item_id`
appeared in the sample. [observed:<USER>/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl; anonymized field count]

### Codex observed vocabulary

The anonymized 30-file sample contained 780 `custom_tool_call` items: `exec` 774,
`send_message` 3, and `wait` 3; six `function_call` items and seven agent metadata records did
not add a counted custom-tool name. [observed:<USER>/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl; anonymized 30-file frequency count]

### Failure, timeout, trust, and unsupported behavior

Codex generated hook schemas use `additionalProperties:false`, so malformed or extra fields are
contract failures rather than extensibility. [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json]

Non-managed hooks require review/trust recorded against the handler's current hash. [observed:<USER>/.codex/config.toml]
Installation and trusted state are separate adapter/doctor states. [docs:https://github.com/TomaszGonczar/dcompact/blob/main/docs/CONCEPT.md]

`SessionEnd` has a one-second default timeout, so synchronous persistence must fit that budget or
degrade/defer while preserving host availability. [docs:https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/session_end.rs]

Multiple matching command hooks run concurrently, so dcompact must not assume it is alone. [docs:https://github.com/TomaszGonczar/dcompact/blob/main/docs/CONCEPT.md]
Local handlers that swallow failures prove configuration only, not successful injection. [observed:<USER>/.codex/hooks.json]

## 4. OMP adapter

### Configuration, version, and extension discovery

Global OMP settings are `~/.omp/agent/config.yml`, with legacy `~/.omp/agent/settings.json`
migrated once when `config.yml` is absent; project settings are `<cwd>/.omp/config.yml` and
legacy `<cwd>/.omp/settings.json`. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md]

Precedence from low to high is built-in defaults, global, project, repeatable `--config`
overlays, then runtime overrides; legacy project settings merge first and `config.yml` wins,
objects deep-merge, and arrays/scalars replace wholesale. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md]

`PI_CODING_AGENT_DIR` relocates the active agent directory; profiles use the documented
`~/.omp/profiles/<name>/agent` location unless overridden. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md]

The adapter probes `omp --version` or `omp -v`. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/cli-reference.md]
The local executable reported `omp/18.1.18`. [observed:omp-version-command]

An extension is a TS/JS module with a default factory; native discovery includes `<cwd>/.omp/extensions/`
and the global agent extensions directory, with manifest/package/index resolution and first-seen
absolute-path de-duplication. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md]

Extensions are in-process and unsandboxed; registration occurs in the factory, and runtime
actions occur during events/commands/tools. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md]

### Registered event and exact contracts

The OMP adapter registers only `session_compact`, a post-compaction notification used to
record the saved summary. `session_before_compact`, `session.compacting`, `context`,
`before_agent_start`, tool events, and commands are reference-only and are not implementation
inputs until their runtime probes are complete. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md]

| Event | Field | Type | Required | Meaning | Evidence |
|---|---|---|---|---|---|
| `session_compact` | `type` | literal `"session_compact"` | yes | event discriminator | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/shared-events.ts] |
| `session_compact` | `compactionEntry` | `CompactionEntry` object | yes | saved compaction entry | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/shared-events.ts] |
| `session_compact` | `fromExtension` | boolean | yes | whether extension supplied result | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/shared-events.ts] |

The registered `CompactionEntry` nested object has this exact field contract; its base
identity fields and compaction-specific fields are all required unless marked optional. [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts]

| Object | Field | Type | Required | Meaning | Evidence |
|---|---|---|---|---|---|
| `CompactionEntry` | `type` | literal `"compaction"` | yes | entry discriminator | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |
| `CompactionEntry` | `id` | string | yes | entry identity | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |
| `CompactionEntry` | `parentId` | string or null | yes | parent entry identity | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |
| `CompactionEntry` | `timestamp` | string | yes | entry timestamp | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |
| `CompactionEntry` | `summary` | string | yes | compaction summary | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |
| `CompactionEntry` | `firstKeptEntryId` | string | yes | first retained entry after the compaction boundary | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |
| `CompactionEntry` | `tokensBefore` | number | yes | estimated tokens before compaction | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |
| `CompactionEntry` | `shortSummary` | string | no | short display summary | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |
| `CompactionEntry` | `tokensAfter` | number | no | estimated context tokens after rewrite | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |
| `CompactionEntry` | `method` | `CompactionMethod` | no | method that produced the entry | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |
| `CompactionEntry` | `providerReplayThroughEntryId` | string | no | last entry represented by provider-native replay history | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |
| `CompactionEntry` | `details` | unknown / extension-specific `T` | no | extension-specific data | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |
| `CompactionEntry` | `preserveData` | `Record<string, unknown>` | no | hook-provided persisted data | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |
| `CompactionEntry` | `fromExtension` | boolean | no | whether an extension generated the entry | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |
| `CompactionEntry` | `warning` | string | no | post-pass progress warning | [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts] |

The `session_compact` handler output is `void` (or `Promise<void>`); it cannot block, cancel, or
replace compaction, and it has no context-injection channel. [docs:https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/hooks/types.ts]

Dcompact's handler reads the event's `compactionEntry` and `fromExtension` fields and performs
the snapshot operation as its side effect; it injects no context into the post-compaction event. [observed:<repo>/docs/briefs/OMP-BATCH-2.md]

The broader OMP event inventory is reference-only; the registered set is the `session_compact`
event defined above. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/hooks.md]

The following documented return shapes are reference-only because those events are not
registered; they are deliberately excluded from the implementation contract. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/hooks.md]

`session_before_compact` returns `{cancel?: boolean, compaction?: CompactionResult}` and may
cancel or supply the complete custom compaction result. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/hooks.md]

`session.compacting` returns `{context?: string[], prompt?: string, preserveData?: Record<string, unknown>}`;
each context string contributes a line under `<additional-context>` in the default compaction
prompt. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md]

`session_compact` exposes the saved `compactionEntry` and `fromExtension`; it is post-compaction
notification, not equivalent to pre-compaction context contribution. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md]

`context` returns `{messages?: Message[]}` and forms a replacement chain; `before_agent_start`
returns one injected message with `{customType, content, display, details, attribution}`.
[docs:https://github.com/can1357/oh-my-pi/blob/main/docs/hooks.md]

`tool_call` receives a pre-execution event and may return `{block?, reason?, input?}`; `tool_result`
contains `toolName`, `toolCallId`, `input`, `content`, `details`, and boolean `isError`, and a
failed result rethrows the original error. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/hooks.md]

The minimal OMP contract provides no context injection; `session.compacting` remains outside
the registered set until its runtime contract is verified. [observed:<repo>/docs/briefs/OMP-BATCH-2.md]

### Identity, journal, and normalization

The persisted session entry contains `id`, and the live extension identity source is
`ctx.sessionManager.getSessionId()`; filesystem recency and MCP child-process identity are not
valid substitutes. [observed:repo-adr-001-omp-identity-audit]

If identity is absent, the shared refusal rule applies: list candidates and require explicit
`--session` or `--transcript`; do not infer a journal from newest/most recent ordering.
[observed:repo-adr-001-omp-identity-audit]

The journal is redacted-path JSONL; the observed sample had one metadata header plus 1,064
entries, 1,065 physical lines, a final newline, and 6,203,496 bytes. [observed:omp-journal-sample-2026-08-23-1064-entries.jsonl]

The metadata header is `title` 1; entry counts are `session` 1, `model_change` 7,
`thinking_level_change` 5, `message` 690, `custom` 353, `title_change` 2,
`credential_pin` 2, `custom_message` 3, and `compaction` 1; these sum to 1,064 entries.
[observed:omp-journal-sample-2026-08-23-1064-entries.jsonl]

Entries link through `id`, `parentId`, and `timestamp`; compaction adds `firstKeptEntryId`, and
branch summaries use `fromId`. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/session.md]

Assistant `toolCall` blocks pair to `toolResult` records by `toolCallId`; the sample had 353
calls, 353 results, 353 unique IDs, and zero unmatched records. [observed:omp-journal-sample-2026-08-23-1064-entries.jsonl]

Tool results use role `toolResult` and `{role, toolCallId, toolName, content, details, isError,
timestamp}`; no sampled result had `exitCode`. [observed:omp-journal-sample-2026-08-23-1064-entries.jsonl]

The sample had 20 `isError:true` results; `details` may include `timeoutSeconds` and
`wallTimeMs`, and `custom` records of `customType: tool_execution_start` are an explicit ignore
case. [observed:omp-journal-sample-2026-08-23-1064-entries.jsonl]

The compaction entry was at the 980-entry boundary; all 980 pre-compaction entries remained on
disk while 617 pre-compaction messages were no longer model-visible. [observed:wave1-omp-journal-audit]

That audit also measured 376 paired tool calls/results with zero unmatched IDs; the separate path
scope audit found 124 of 133 file operations outside one repo root and none of 35 writes/35 edits
inside it. [observed:wave1-omp-journal-audit]
This path-scope result is workflow-scoped rather than a universal rate. [observed:wave1-omp-path-scope-audit]

### OMP observed vocabulary

The redacted sample contained 353 calls: `bash` 165, `read` 77, `grep` 45, `edit` 20, `write`
15, `todo` 13, `hub` 10, and `glob` 8. [observed:omp-journal-sample-2026-08-23-1064-entries.jsonl]

The measured overlap between this lower-case OMP vocabulary and the earlier Claude-centric list
was zero. [observed:wave1-omp-vocabulary-overlap-audit]

### Failure, timeout, trust, and unsupported behavior

Invalid extension modules/default exports are captured as load errors while other hooks continue;
event handler exceptions are caught and emitted as extension errors. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md]

`tool_call` handler errors fail closed and block execution, while underlying tool failures emit an
error result and rethrow. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/hooks.md]
Detached timer exceptions can be process-fatal. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md]

Dynamic model discovery from an extension has a documented 15-second timeout. [docs:https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md]

Unknown shapes must produce `schema-drift`/`extraction-empty`; unmapped tools count and lower
coverage without adding degraded state, and explicit ignore records remain fixture-tested.
[observed:repo-wave1-extraction-rulings]

## 5. Final blocked verification tasks

The following are the only unresolved claims and are not implementation inputs. [observed:<repo>/docs/briefs/OMP-BATCH-2.md]

1. Repeat the disposable Claude `SessionStart` probe after a controlled CLI version upgrade and
   compare its field/type set with the recorded 2.1.238 baseline. [unverified]
2. Run disposable Codex SessionStart/SessionEnd hooks with missing `session_id` and capture
   refusal/degradation behavior; test increasing `additionalContext` sizes for truncation/spill.
   [unverified]
3. Pin a Codex commit and inspect rollout protocol structs or fixture-probe inner
   `response_item` fields across an upgrade; mutate a disposable hook and observe trust-by-hash
   refusal, refresh, or degraded behavior. [unverified]
4. Run a disposable OMP extension and log redacted inputs/order for `session_before_compact`,
   `session.compacting`, and `session_compact`; verify exact context placement and identity
   behavior when the session manager has no ID. [unverified]
5. Interrupt a disposable OMP journal write and resume; verify final-line recovery, flush/
   atomicity, malformed-record handling, and byte limits, then capture a second release sample to
   test whether the measured vocabulary generalizes. [unverified]
