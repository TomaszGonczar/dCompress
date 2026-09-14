/**
 * Coverage accounting — what the framework can say about tool calls it did not understand.
 *
 * `unmapped_tool_calls` and `coverage_ppm` already live in the payload, because the extractors
 * count them (SCHEMA §3.1). What the framework adds is the *histogram*: which names were missed,
 * and how often. That is the value a future `doctor --json` reports, and it is the difference
 * between "coverage fell to 91%" and "the agent started emitting `mcp__srv__apply_patch`".
 *
 * The counters are read from the payload rather than recomputed, so the histogram can never
 * disagree with the header the same snapshot renders. The one invariant that could break — a
 * histogram whose total differs from `unmapped_tool_calls` — is checked and reported as an
 * internal error instead of being rendered as if it were true.
 */

import type { NormalizedEvent, Payload, ToolKind } from "../core/types.js";

/** Longest rendered tool name; a name is transcript data and must not dominate a histogram. */
const MAX_NAME_LENGTH = 64;

/**
 * Control characters that must never reach a rendered report — a transcript-supplied tool name
 * could otherwise rewrite a terminal line.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export interface CoverageReport {
  readonly source_tool_calls: number;
  readonly unmapped_tool_calls: number;
  readonly coverage_ppm: number;
  /** Tool name → number of calls left unmapped, sorted by name. */
  readonly unmapped_by_tool: Readonly<Record<string, number>>;
}

/** Control characters never reach a report, and neither does an unbounded name. */
function histogramKey(name: string): string {
  const printable = name.replace(CONTROL_CHARACTERS, "");
  if (printable.length === 0) return "<unnamed>";
  return printable.length <= MAX_NAME_LENGTH ? printable : Array.from(printable).slice(0, MAX_NAME_LENGTH).join("");
}

export function coverageReport(payload: Payload, events: readonly NormalizedEvent[], toolKinds: Readonly<Record<string, ToolKind>>): CoverageReport {
  // Null-prototype: a tool named `constructor` is transcript data, and reading it out of an
  // object literal would hand back `Object.prototype.constructor` and turn the count into a
  // string. The same reason the definition's tables are built this way.
  const histogram = Object.create(null) as Record<string, number>;
  let unmapped = 0;
  for (const event of events) {
    // The same predicate the extractors apply: a call whose kind is absent from the map is a
    // miss, and one whose name is present is covered even when it yields no fact.
    if (event.type !== "tool" || toolKinds[event.toolName] !== undefined) continue;
    unmapped += 1;
    const key = histogramKey(event.toolName);
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  if (unmapped !== payload.counters.unmapped_tool_calls) {
    throw new RangeError("unmapped tool-call histogram disagrees with the payload counters");
  }
  const sorted = Object.create(null) as Record<string, number>;
  for (const key of Object.keys(histogram).sort()) sorted[key] = histogram[key];
  return {
    source_tool_calls: payload.counters.source_tool_calls,
    unmapped_tool_calls: payload.counters.unmapped_tool_calls,
    coverage_ppm: payload.counters.coverage_ppm,
    unmapped_by_tool: sorted,
  };
}