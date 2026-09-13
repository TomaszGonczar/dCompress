import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../src/core/canonical.js";
import { extractPayload } from "../src/core/extract/index.js";
import { payloadHash } from "../src/core/hash.js";
import type { Envelope, Payload } from "../src/core/types.js";
import {
  configForFixture,
  fixtureNames,
  readFixture,
  type FixtureMetadata,
  type VectorFixture,
} from "./helpers/vectors.js";

const fixtureRoot = join(process.cwd(), "test", "fixtures");
const perturbationKeys = ["TZ", "LANG", "LC_ALL", "HOME"] as const;
type PerturbationKey = (typeof perturbationKeys)[number];

interface HostPerturbation {
  readonly clock: Date;
  readonly cwd: string;
  readonly hostname: string;
  readonly os: string;
  readonly env: Readonly<Record<PerturbationKey, string>>;
}

interface TestEnvelope extends Envelope {
  readonly host: Envelope["host"] & { readonly hostname: string };
}

interface SnapshotResult {
  readonly envelope: TestEnvelope;
  readonly payload: Payload;
  readonly payloadBytes: string;
  readonly hash: string;
  readonly observed: {
    readonly cwd: string;
    readonly env: Readonly<Record<PerturbationKey, string | undefined>>;
  };
}

interface ExpectedVector {
  readonly payload: Payload;
  readonly payloadBytes: string;
  readonly hash: string;
}

function expectedVector(fixture: VectorFixture): ExpectedVector {
  const payload = JSON.parse(
    readFileSync(join(fixture.directory, `${fixture.metadata.name}.payload.json`), "utf8"),
  ) as Payload;
  const hash = readFileSync(join(fixture.directory, `${fixture.metadata.name}.hash`), "utf8").trim();
  return { payload, payloadBytes: canonicalize(payload), hash };
}

function snapshot(fixture: VectorFixture, perturbation: HostPerturbation): SnapshotResult {
  const payload = extractPayload(fixture.events, configForFixture(fixture));
  const payloadBytes = canonicalize(payload);
  const hash = payloadHash(payload);
  const envelope: TestEnvelope = {
    schema_version: "1.0.0",
    canonicalization: 3,
    extractor_version: "0.1.0",
    created_at: perturbation.clock.toISOString(),
    adapter: fixture.metadata.adapterId,
    adapter_version: null,
    session_id: null,
    transcript_path: join(fixture.directory, "transcript.jsonl"),
    transcript_bytes: fixture.transcriptBytes.byteLength,
    transcript_lines: fixture.events.length,
    transcript_mtime: null,
    host: {
      os: perturbation.os,
      arch: "test-arch",
      node: "test-node",
      hostname: perturbation.hostname,
    },
    store: { cwd: process.cwd(), repo_root: fixture.metadata.repoRoot },
    degraded: [],
    previous_hash: null,
    duration_ms: 0,
    hash,
  };
  return {
    envelope,
    payload,
    payloadBytes,
    hash,
    observed: {
      cwd: process.cwd(),
      env: Object.fromEntries(perturbationKeys.map((key) => [key, process.env[key]])) as Readonly<
        Record<PerturbationKey, string | undefined>
      >,
    },
  };
}

function withPerturbation<T>(perturbation: HostPerturbation, callback: () => T): T {
  const originalCwd = process.cwd();
  const originalEnv = new Map<PerturbationKey, string | undefined>();
  for (const key of perturbationKeys) originalEnv.set(key, process.env[key]);

  try {
    for (const key of perturbationKeys) process.env[key] = perturbation.env[key];
    process.chdir(perturbation.cwd);
    return callback();
  } finally {
    process.chdir(originalCwd);
    for (const key of perturbationKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function baselineFor(fixture: VectorFixture): SnapshotResult {
  return snapshot(fixture, {
    clock: new Date("2026-01-02T03:04:05.000Z"),
    cwd: process.cwd(),
    hostname: "baseline-host",
    os: "baseline-os",
    env: {
      TZ: process.env.TZ ?? "",
      LANG: process.env.LANG ?? "",
      LC_ALL: process.env.LC_ALL ?? "",
      HOME: process.env.HOME ?? "",
    },
  });
}

function perturbationFor(fixture: VectorFixture): HostPerturbation {
  return {
    clock: new Date("2042-11-03T19:20:21.000Z"),
    cwd: dirname(fixture.directory),
    hostname: "perturbed-host",
    os: "perturbed-os",
    env: {
      TZ: "Pacific/Kiritimati",
      LANG: "tr_TR.UTF-8",
      LC_ALL: "C",
      HOME: "/tmp/dcompact-determinism-home",
    },
  };
}

const ordinaryFixtureNames = fixtureNames(fixtureRoot).filter((name) => name !== "clock-env");

describe("deterministic payload vectors", () => {
  it.each(ordinaryFixtureNames)("matches committed vector %s", (name) => {
    const fixture = readFixture(name, fixtureRoot);
    const expected = expectedVector(fixture);
    const result = baselineFor(fixture);

    expect(result.payload).toEqual(expected.payload);
    expect(result.payloadBytes).toBe(expected.payloadBytes);
    expect(result.hash).toBe(expected.hash);
    expect(payloadHash(expected.payload)).toBe(expected.hash);
  });

  it("proves vector 10 is vector 2 equivalence under host perturbations", () => {
    const perturbationFixture = readFixture("clock-env", fixtureRoot);
    const metadata = perturbationFixture.metadata as FixtureMetadata & {
      readonly perturbations?: readonly string[];
    };
    const targetName = metadata.equivalentTo;
    expect(targetName).toBe("single-edit");
    expect(metadata.perturbations).toEqual(["TZ", "LANG", "LC_ALL", "HOME", "cwd", "clock", "hostname", "os"]);

    const target = readFixture(targetName as string, fixtureRoot);
    const expected = expectedVector(target);
    const baseline = baselineFor(target);
    const perturbation = perturbationFor(target);
    const changed = withPerturbation(perturbation, () => snapshot(target, perturbation));

    expect(changed.observed.cwd).toBe(perturbation.cwd);
    expect(changed.observed.env).toEqual(perturbation.env);
    expect(changed.envelope.created_at).not.toBe(baseline.envelope.created_at);
    expect(changed.envelope.host.hostname).not.toBe(baseline.envelope.host.hostname);
    expect(changed.envelope.host.os).not.toBe(baseline.envelope.host.os);
    expect(changed.envelope.store.cwd).not.toBe(baseline.envelope.store.cwd);

    expect(changed.payloadBytes).toBe(baseline.payloadBytes);
    expect(changed.hash).toBe(baseline.hash);
    expect(changed.payloadBytes).toBe(expected.payloadBytes);
    expect(changed.hash).toBe(expected.hash);
  });
});
