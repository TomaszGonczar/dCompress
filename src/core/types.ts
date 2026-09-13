/** Values that may occur in the canonical, hashed payload. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export type FactKind =
  | "file.modified"
  | "file.read"
  | "file.created"
  | "file.deleted"
  | "cmd.run"
  | "cmd.failed"
  | "error.raised"
  | "error.fixed"
  | "decision.stated"
  | "todo.state"
  | "plan.state"
  | "git.state"
  | "note";

export type FactScope = "repo" | "cwd" | "granted" | "external" | "uri";

export type ToolKind =
  | "file.modified"
  | "file.read"
  | "file.created"
  | "file.deleted"
  | "command"
  | "cmd.run"
  | "cmd.failed"
  | "ignored";

export interface Evidence {
  readonly line: number;
  readonly sha256: string;
}

export interface FactAt {
  readonly entry: number;
  readonly ts: string | null;
}

export interface Fact {
  readonly kind: FactKind;
  readonly key: string;
  readonly scope?: FactScope;
  readonly at: FactAt;
  readonly attrs: Record<string, CanonicalValue>;
  readonly evidence: Evidence[];
  readonly snippet: string;
  readonly unbacked: boolean;
}

export interface PayloadCounters {
  readonly facts: number;
  readonly by_kind: Record<string, number>;
  readonly source_entries: number;
  readonly source_tool_calls: number;
  readonly unmapped_tool_calls: number;
  readonly coverage_ppm: number;
  readonly external_path_count: number;
}

export interface GitPayload {
  readonly head: string;
  readonly branch: string;
  readonly dirty: boolean;
  readonly status_hash: string;
  readonly diff_stat: {
    readonly files: number;
    readonly added: number;
    readonly removed: number;
  };
}

export interface PlanPayload {
  readonly todos: number;
  readonly done: number;
  readonly items: string[];
}

export interface Payload {
  readonly facts: Fact[];
  readonly counters: PayloadCounters;
  readonly git: GitPayload | null;
  readonly plan: PlanPayload | null;
  readonly path_base: "repo" | "cwd";
  readonly version: 1;
}

export interface HostInfo {
  readonly os: string;
  readonly arch: string;
  readonly node: string;
}

export interface StoreInfo {
  readonly cwd: string;
  readonly repo_root: string | null;
}

export type AdapterId = "claude" | "codex" | "omp" | "generic";

export type DegradedState =
  | "ok"
  | "schema-drift"
  | "extraction-empty"
  | "provenance-broken"
  | "budget-exceeded"
  | "internal-error"
  | "unavailable:agent-not-installed"
  | "unavailable:store"
  | "untrusted:hook-pending-review"
  | "no-pre-compaction-hook";

export interface Envelope {
  readonly schema_version: string;
  readonly canonicalization: number;
  readonly extractor_version: string;
  readonly created_at: string;
  readonly adapter: AdapterId;
  readonly adapter_version: string | null;
  readonly session_id: string | null;
  readonly transcript_path: string | null;
  readonly transcript_bytes: number;
  readonly transcript_lines: number;
  readonly transcript_mtime: string | null;
  readonly host: HostInfo;
  readonly store: StoreInfo;
  readonly degraded: DegradedState[];
  readonly previous_hash: string | null;
  readonly duration_ms: number;
  readonly hash: string;
}

export interface Snapshot {
  readonly envelope: Envelope;
  readonly payload: Payload;
}

export interface ScopeRoot {
  readonly root: string;
  readonly scope: "repo" | "cwd" | "granted";
}

export interface PathNormalizationOptions {
  readonly repoRoot?: string | null;
  readonly cwd: string;
  readonly scopeRoots?: ScopeRoot[];
  readonly pathBase?: "repo" | "cwd";
}

export interface NormalizedPath {
  readonly path: string;
  readonly scope: FactScope;
}

interface NormalizedEventBase {
  readonly entry: number;
  readonly line: number;
  readonly rawLine: string | Uint8Array;
  readonly timestamp: string | null;
}

export interface NormalizedToolEvent extends NormalizedEventBase {
  readonly type: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly intent?: string;
  readonly path?: string;
  readonly command?: string;
  readonly isError: boolean;
  readonly errorMessage?: string;
}

export interface NormalizedUserEvent extends NormalizedEventBase {
  readonly type: "user";
  readonly text: string;
}

export interface NormalizedTodoEvent extends NormalizedEventBase {
  readonly type: "todo";
  readonly state: "open" | "done";
  readonly text: string;
  readonly item?: number;
}

export interface NormalizedPlanEvent extends NormalizedEventBase {
  readonly type: "plan";
  readonly todos: number;
  readonly done: number;
  readonly items: string[];
}

export interface NormalizedGitEvent extends NormalizedEventBase {
  readonly type: "git";
  readonly head: string;
  readonly branch: string;
  readonly dirty: boolean;
  readonly statusHash: string;
  readonly diffStat: {
    readonly files: number;
    readonly added: number;
    readonly removed: number;
  };
}

export interface NormalizedIgnoredEvent extends NormalizedEventBase {
  readonly type: "ignored";
  readonly reason: string;
}

export type NormalizedEvent =
  | NormalizedToolEvent
  | NormalizedUserEvent
  | NormalizedTodoEvent
  | NormalizedPlanEvent
  | NormalizedGitEvent
  | NormalizedIgnoredEvent;

export interface ExtractConfig {
  readonly adapterId: AdapterId;
  readonly toolKinds: Readonly<Record<string, ToolKind>>;
  readonly scopeRoots: ScopeRoot[];
  readonly cwd: string;
  readonly repoRoot: string | null;
  readonly pathBase: "repo" | "cwd";
  readonly decisionCues: readonly string[];
}

export interface PackOptions {
  readonly maxBytes?: number;
  readonly maxFacts?: number;
  readonly includeEvidence?: boolean;
}

export type ErrorClass =
  | "permission"
  | "not_found"
  | "timeout"
  | "connection"
  | "syntax"
  | "type"
  | "assertion"
  | "quota"
  | "conflict"
  | "cancelled"
  | "unknown";
