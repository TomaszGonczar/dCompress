/**
 * The built-in mappers — the code half of each shipped adapter, bound to its definition.
 *
 * Adding an agent is a definition file plus a mapper function: the definition is declared data
 * (`adapters/<agent>.json`) and the mapper is the parsing logic that cannot be expressed as
 * data without becoming a language. This module is where the two are bound, and the only place
 * a caller needs in order to drive a shipped adapter.
 *
 * The definition is read once per process. It is read-only package data, so caching it is safe;
 * loading it is *not* lazy-by-accident — a caller that needs a definition different from the
 * shipped one passes it to `extractWithAdapter` explicitly, which is what the framework tests
 * and a future `install`/`doctor` do.
 */

import { join } from "node:path";

import { claudeExtractConfig, parseClaudeTranscript } from "./claude.js";
import { adapterDirectory, extractWithAdapter, requireAdapterDefinition } from "./registry.js";
import type { AdapterDefinition, AdapterExtraction, AdapterMapper } from "./registry.js";
import type { ClaudeParseResult } from "./claude.js";

export const CLAUDE_MAPPER: AdapterMapper<ClaudeParseResult> = (bytes, definition) => {
  const parse = parseClaudeTranscript(bytes, definition);
  return { parse, config: claudeExtractConfig(parse, definition) };
};

let cached: AdapterDefinition | null = null;

/** The shipped Claude definition. Throws `AdapterDefinitionRefusal` naming the file if it is unusable. */
export function claudeDefinition(): AdapterDefinition {
  cached ??= requireAdapterDefinition(join(adapterDirectory(), "claude.json"));
  return cached;
}

/** Map, drift-check, and extract one Claude transcript through the framework. */
export function readClaudeTranscript(bytes: Uint8Array): AdapterExtraction<ClaudeParseResult> {
  return extractWithAdapter(claudeDefinition(), CLAUDE_MAPPER, bytes);
}