import { mergeFacts } from "./canonical.js";
import type { Fact, Payload } from "./types.js";

/**
 * Merge checkpoint payloads without introducing a second extraction path.
 *
 * Checkpoints are intentionally payloads, not transcript fragments. Facts are historical and are
 * retained across the chain; source counters describe one coherent input only: the newest
 * checkpoint. Continuity snapshots are cumulative, so numeric aggregate attrs use a deterministic
 * maximum across the same identity rather than summing the same work repeatedly.
 */
export function mergeCheckpointPayloads(payloads: readonly Payload[]): Payload {
  if (payloads.length === 0) {
    throw new RangeError("At least one checkpoint payload is required");
  }

  const latestByIdentity = new Map<string, Fact>();
  const factsByIdentity = new Map<string, Fact[]>();
  const latestIndex = payloads.length - 1;
  for (const [index, payload] of payloads.entries()) {
    for (const fact of payload.facts) {
      const identity = `${fact.kind}\u0000${fact.key}`;
      const history = factsByIdentity.get(identity);
      if (history) history.push(fact);
      else factsByIdentity.set(identity, [fact]);
      // Chain order/latest checkpoint wins for the same canonical fact identity. Facts that only
      // exist in an earlier checkpoint cannot be verified against the newest transcript.
      latestByIdentity.set(identity, index === latestIndex ? fact : { ...fact, unbacked: true });
    }
  }
  // mergeFacts preserves ordering, bounded evidence, and the latest authoritative description.
  const facts = mergeFacts([...latestByIdentity.values()]).map((fact) => {
    const history = factsByIdentity.get(`${fact.kind}\u0000${fact.key}`) ?? [];
    const attrs = { ...fact.attrs };
    const names = new Set(history.flatMap((item) => Object.keys(item.attrs)));
    for (const name of names) {
      const numeric = history
        .map((item) => item.attrs[name])
        .filter((value): value is number => typeof value === "number");
      if (numeric.length > 0) attrs[name] = Math.max(...numeric);
    }
    return { ...fact, attrs };
  });
  const latest = payloads[payloads.length - 1];
  const byKind: Record<string, number> = {};
  for (const fact of facts) byKind[fact.kind] = (byKind[fact.kind] ?? 0) + 1;

  const source = latest.counters;
  const externalPathCount = facts.filter((fact) => fact.scope === "external").length;

  return {
    ...latest,
    facts,
    counters: {
      facts: facts.length,
      by_kind: byKind,
      source_entries: source.source_entries,
      source_tool_calls: source.source_tool_calls,
      unmapped_tool_calls: source.unmapped_tool_calls,
      coverage_ppm: source.coverage_ppm,
      external_path_count: externalPathCount,
    },
  };
}
