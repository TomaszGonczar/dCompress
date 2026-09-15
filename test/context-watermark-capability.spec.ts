import { describe, expect, it } from "vitest";

import { claudeDefinition } from "../src/adapters/mappers.js";
import { contextWatermarkCapability } from "../src/adapters/registry.js";

/**
 * OG-81 capability matrix. Only Claude has a shipped adapter definition; Codex and OMP have no
 * definition at all (OG-63/OG-64 are unbuilt), and the generic fallback has no hook surface to
 * observe telemetry from. `contextWatermarkCapability` must report exactly that split — a real
 * `supported` for Claude, and an explicit, asserted `unsupported` for the other three, never a
 * fabricated `true` and never merely absent from the report.
 */
describe("contextWatermarkCapability: OG-81 capability matrix", () => {
  it("reports Claude as supported, with the fields ADAPTER-SPEC.md has not confirmed left null", () => {
    const capability = contextWatermarkCapability("claude", claudeDefinition());
    expect(capability.supported).toBe(true);
    // Never a guessed field name: ADAPTER-SPEC.md's measured PreCompact/SessionStart tables carry
    // no token counts, so there is nothing honest to name here.
    expect(capability.used_tokens_field).toBeNull();
    expect(capability.context_limit_tokens_field).toBeNull();
    expect(capability.evidence).toMatch(/^(docs|observed):\S+$/);
  });

  it("reports Codex, OMP, and the generic fallback as unsupported, explicitly", () => {
    for (const adapter of ["codex", "omp", "generic"] as const) {
      const capability = contextWatermarkCapability(adapter, null);
      expect(capability.supported).toBe(false);
      expect(capability.used_tokens_field).toBeNull();
      expect(capability.context_limit_tokens_field).toBeNull();
      expect(capability.evidence).toBeNull();
    }
  });

  it("never fabricates supported: true for an adapter with no definition, even one named claude", () => {
    // Guards the branch itself, not just the shipped data: passing `null` in place of a loaded
    // definition must degrade to unsupported rather than assume Claude's shape.
    const capability = contextWatermarkCapability("claude", null);
    expect(capability.supported).toBe(false);
  });
});
