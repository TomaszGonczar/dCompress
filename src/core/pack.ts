import { payloadHash } from "./hash.js";
import type { CanonicalValue, DegradedState, Fact, PackOptions, Payload } from "./types.js";

const PRIORITY: Record<Fact["kind"], number> = {
  "decision.stated": 5,
  "error.raised": 10,
  "error.fixed": 15,
  "file.created": 20,
  "file.deleted": 20,
  "file.modified": 30,
  "cmd.failed": 40,
  "cmd.run": 50,
  "file.read": 60,
  "todo.state": 70,
  "plan.state": 70,
  "git.state": 80,
  note: 90,
};

const TITLES: Record<number, string> = {
  5: "Decisions",
  10: "Errors",
  15: "Error fixes",
  20: "File lifecycle",
  30: "File changes",
  40: "Failed commands",
  50: "Commands",
  60: "Reads",
  70: "Todo and plan",
  80: "Git state",
  90: "Notes",
};

function safe(value: string): string {
  let result = "";
  for (const character of value.normalize("NFC")) {
    const code = character.codePointAt(0) ?? 0;
    result += code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? "�" : character;
  }
  return result.replace(/[\t ]+/g, " ").trim();
}

function markdown(value: string): string {
  return safe(value).replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("*", "\\*").replaceAll("_", "\\_").replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll("#", "\\#").replaceAll("|", "\\|");
}

function valueText(value: CanonicalValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return markdown(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(valueText).join(", ");
  return Object.keys(value).sort().map((key) => `${markdown(key)}=${valueText(value[key])}`).join(", ");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  const a = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const b = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

function displayCompare(left: Fact, right: Fact): number {
  const priority = PRIORITY[left.kind] - PRIORITY[right.kind];
  if (priority !== 0) return priority;
  const recent = right.at.entry - left.at.entry;
  if (recent !== 0) return recent;
  return compareCodePoints(left.key, right.key) || compareCodePoints(left.kind, right.kind) || compareCodePoints(left.snippet, right.snippet);
}

function groups(facts: readonly Fact[]): Array<{ priority: number; facts: Fact[] }> {
  const grouped = new Map<number, Fact[]>();
  for (const fact of [...facts].sort(displayCompare)) {
    const priority = PRIORITY[fact.kind];
    const group = grouped.get(priority);
    if (group === undefined) grouped.set(priority, [fact]);
    else group.push(fact);
  }
  return [...grouped.entries()].sort((left, right) => left[0] - right[0]).map(([priority, group]) => ({ priority, facts: group }));
}

function factLine(fact: Fact, includeEvidence: boolean): string {
  const attrs = Object.keys(fact.attrs).sort().map((key) => `${markdown(key)}=${valueText(fact.attrs[key])}`).join(" ");
  const evidence = includeEvidence ? fact.evidence.map((item) => `line ${item.line}`).join(", ") : "";
  const suffix = [attrs, markdown(fact.snippet), evidence].filter(Boolean).join(" — ");
  return `- **${markdown(fact.kind)}** \`${markdown(fact.key)}\`${suffix ? `: ${suffix}` : ""}`;
}

/**
 * Render the health line from finite `DegradedState` tokens.
 *
 * The caller passes states, never text: the vocabulary is closed, so the header cannot say
 * something the product does not model. Each state keeps its documented family — `unavailable:`
 * and `untrusted:` tokens already name their family, so prefixing them with `degraded` would
 * misreport an unavailable store as a degraded extraction. Only the plain internal tokens are
 * reported under `degraded:`. `ok` means "no other state" and is filtered rather than combined.
 * The order is fixed so equal health renders identically.
 */
export function formatDegradedStates(degraded: readonly DegradedState[]): string {
  const states = [...new Set(degraded)]
    .filter((state) => state !== "ok")
    .map((state) => (state.startsWith("unavailable:") || state.startsWith("untrusted:") ? state : `degraded: ${state}`))
    .sort();
  return states.length === 0 ? "ok" : states.join(", ");
}

function header(payload: Payload, degraded: readonly DegradedState[] | undefined): string[] {
  const marker = `[dcompact:${payloadHash(payload).slice(7, 19)}]`;
  return [
    `## dcompact context ${marker}`,
    ...(degraded === undefined ? [] : [`Status: ${formatDegradedStates(degraded)}`]),
    `Facts: ${payload.counters.facts} | external: ${payload.counters.external_path_count} | unmapped: ${payload.counters.unmapped_tool_calls} | coverage: ${payload.counters.coverage_ppm} ppm`,
    `Source entries: ${payload.counters.source_entries} | tool calls: ${payload.counters.source_tool_calls}`,
  ];
}

function renderGroups(groupsToRender: readonly { priority: number; facts: Fact[] }[], includeEvidence: boolean): string[] {
  const lines: string[] = [];
  for (const group of groupsToRender) {
    lines.push(`### ${TITLES[group.priority] ?? "Facts"}`);
    for (const fact of group.facts) lines.push(factLine(fact, includeEvidence));
    lines.push("");
  }
  return lines;
}

export function renderPack(payload: Payload, options?: PackOptions): string {
  const maxBytes = options?.maxBytes ?? 16 * 1024;
  const maxFacts = options?.maxFacts ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative integer");
  if (!Number.isSafeInteger(maxFacts) || maxFacts < 0) throw new RangeError("maxFacts must be a non-negative integer");

  const allGroups = groups(payload.facts);
  const selectedGroups: Array<{ priority: number; facts: Fact[] }> = [];
  let selectedCount = 0;
  for (const group of allGroups) {
    if (selectedCount + group.facts.length > maxFacts) break;
    selectedGroups.push(group);
    selectedCount += group.facts.length;
  }
  const omittedByMaxFacts = payload.facts.length - selectedCount;
  const base = header(payload, options?.degraded);
  const includeEvidence = options?.includeEvidence === true;
  const notice = (count: number): string => `> [dcompact] elided ${count} fact${count === 1 ? "" : "s"} to fit ${maxBytes} UTF-8 bytes.`;
  const mandatory = (count: number): string => `${[...base, notice(count)].join("\n")}\n`;
  const baseResult = `${base.join("\n")}\n`;
  if (byteLength(baseResult) > maxBytes) throw new RangeError("maxBytes cannot contain the mandatory dcompact header");

  let groupsToRender = selectedGroups;
  let omittedCount = omittedByMaxFacts;
  while (true) {
    const body = renderGroups(groupsToRender, includeEvidence);
    const result = `${[...base, ...body, ...(omittedCount > 0 ? [notice(omittedCount)] : [])].join("\n").replace(/\n+$/, "")}\n`;
    if (byteLength(result) <= maxBytes) return result;
    if (omittedCount > 0 && byteLength(mandatory(omittedCount)) > maxBytes) throw new RangeError("maxBytes cannot contain the mandatory dcompact header and elision notice");
    const last = groupsToRender.at(-1);
    if (last === undefined) throw new RangeError("maxBytes cannot contain the mandatory dcompact header and elision notice");
    omittedCount += last.facts.length;
    groupsToRender = groupsToRender.slice(0, -1);
    if (byteLength(mandatory(omittedCount)) > maxBytes) throw new RangeError("maxBytes cannot contain the mandatory dcompact header and elision notice");
  }
}

export default renderPack;
