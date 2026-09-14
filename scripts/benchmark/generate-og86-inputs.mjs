import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outputRoot = resolve("docs/benchmark/og86-medium-v1");

const phases = [
  {
    phase: 1,
    file_symbol: [
      ["src/parser.js defines parseReservation", "parser.js parseReservation"],
      ["src/ledger.js defines addReservation", "ledger.js addReservation"],
      ["test/phase1.test.js covers the seeded defects", "phase1.test.js seeded defects"],
      ["reservation records contain id guest cents and status", "id guest cents status"],
      ["ledger.records preserves reservation history", "ledger records history"],
    ],
    requirement: [
      ["decimal prices parse to exact integer cents", "exact integer cents"],
      ["duplicate reservation ids are rejected before mutation", "duplicate reservation rejected"],
      ["the serialized reservation JSON shape stays unchanged", "JSON record shape unchanged"],
    ],
    negative_constraint: [
      ["preserve parseReservation and addReservation signatures", "preserve exported signatures"],
      ["add no dependency for the parser repair", "no dependency"],
      ["do not rewrite existing ledger history", "no history rewrite"],
      ["choose decimal-string parsing instead of floating-point multiplication", "reject floating point multiplication"],
    ],
    linkage: [
      ["10.10 exposed unsafe floating-point cent conversion", "floating point caused cent conversion failure"],
      ["parsing decimal digits directly fixed exact cents", "direct digit parsing fixed cents"],
      ["duplicate ids overwrote an existing ledger row", "duplicate overwrite caused history mutation"],
      ["throwing before mutation fixed duplicate handling", "throw before mutation fixed duplicate"],
    ],
    command_test: [
      ["the initial npm test run exposed two seeded failures", "initial npm test two failures"],
      ["the final npm test run passed the phase-one tests", "final npm test passed"],
      ["the exact JSON fixture remained byte-for-byte unchanged", "JSON fixture unchanged"],
      ["the decimal and duplicate regression tests both passed", "decimal duplicate tests passed"],
    ],
    unresolved: [
      ["idempotent replay remains future work after phase one", "replay remains"],
      ["cancellation revenue remains future work after phase one", "cancellation remains"],
      ["dry-run import remains future work after phase one", "dry run remains"],
    ],
    provenance: [
      ["the decimal regression is evidenced by phase1.test.js", "phase1.test.js decimal"],
      ["the duplicate regression is evidenced by the unchanged ledger.records assertion", "ledger records assertion"],
    ],
  },
  {
    phase: 2,
    file_symbol: [
      ["src/replay.js defines replay", "replay.js replay"],
      ["src/ledger.js participates in replay idempotence", "ledger.js replay idempotence"],
      ["the replay tests compare one pass with two passes", "replay one pass two passes"],
      ["event identity prevents duplicate replay application", "event identity duplicate application"],
      ["first-seen reservation order stays stable", "first seen order stable"],
    ],
    requirement: [
      ["replaying twice equals replaying once", "replay twice equals once"],
      ["replay preserves stable first-seen insertion order", "stable insertion order"],
      ["the public record shape remains unchanged during replay", "record shape unchanged replay"],
    ],
    negative_constraint: [
      ["reject a process-global replay cache", "no process global cache"],
      ["add no runtime dependency for replay", "no runtime dependency"],
      ["keep replay state local to the ledger operation", "local replay state"],
      ["preserve the phase-one parser and duplicate fixes", "preserve parser duplicate fixes"],
    ],
    linkage: [
      ["reapplying reservation events caused duplicate-id failures", "reapplying events caused duplicate failures"],
      ["tracking applied event identity made replay idempotent", "event identity made replay idempotent"],
      ["rebuilding through unordered aggregation threatened insertion order", "unordered aggregation threatened order"],
      ["first-seen ordered traversal preserved deterministic ordering", "ordered traversal preserved ordering"],
    ],
    command_test: [
      ["npm test exercised replay idempotence", "npm test replay idempotence"],
      ["the replay-twice equality assertion passed", "replay twice assertion passed"],
      ["the stable ordering assertion passed", "ordering assertion passed"],
      ["all earlier phase tests remained green", "earlier tests remained green"],
    ],
    unresolved: [
      ["tombstone compaction policy remains unresolved", "tombstone policy unresolved"],
      ["cancellation revenue remains the next diagnosed defect", "cancellation revenue next"],
      ["batch import dry-run remains unimplemented", "dry run unimplemented"],
    ],
    provenance: [
      ["replay idempotence is backed by its one-pass versus two-pass test", "one pass versus two pass test"],
      ["stable order is backed by the first-seen ordering test", "first seen ordering test"],
    ],
  },
  {
    phase: 3,
    file_symbol: [
      ["src/ledger.js defines cancelReservation", "ledger.js cancelReservation"],
      ["src/report.js defines activeRevenue", "report.js activeRevenue"],
      ["src/report.js defines report", "report.js report"],
      ["cancellation tests span ledger and report behavior", "cancellation tests ledger report"],
      ["append-only records retain reservation and cancellation history", "append only records cancellation history"],
    ],
    requirement: [
      ["active revenue excludes cancelled reservations", "revenue excludes cancelled"],
      ["cancellation preserves append-only history", "cancellation append only"],
      ["integer cents and serialized record shape remain unchanged", "integer cents record shape unchanged"],
    ],
    negative_constraint: [
      ["do not delete cancelled records", "do not delete records"],
      ["do not rewrite stored reservation records", "do not rewrite stored records"],
      ["preserve exported report and ledger signatures", "preserve report ledger signatures"],
      ["reject history mutation as the cancellation repair", "reject history mutation"],
    ],
    linkage: [
      ["activeRevenue summed superseded and cancelled rows", "activeRevenue counted cancelled rows"],
      ["the duplicated historical amount caused inflated revenue", "historical amount inflated revenue"],
      ["deriving current state by reservation id fixed report totals", "derive current state fixed totals"],
      ["cancellation and report regression tests verified the fix", "cancellation report tests verified fix"],
    ],
    command_test: [
      ["the seeded cancellation report test failed before repair", "cancellation test failed before"],
      ["npm test passed after the cancellation repair", "npm test passed cancellation"],
      ["the append-only history assertion passed", "append only assertion passed"],
      ["the stored fixture bytes stayed unchanged", "stored fixture bytes unchanged"],
    ],
    unresolved: [
      ["tombstone compaction policy is still unresolved", "tombstone policy still unresolved"],
      ["dry-run batch import is the next feature", "dry run next feature"],
      ["atomic mixed-validity import is not yet the active task", "atomic import not yet active"],
    ],
    provenance: [
      ["the revenue fix is evidenced by cancellation report tests", "cancellation report tests"],
      ["append-only behavior is evidenced by preserved record-history assertions", "record history assertions"],
    ],
  },
  {
    phase: 4,
    file_symbol: [
      ["src/import.js defines importBatch", "import.js importBatch"],
      ["src/cli.js preserves the public CLI arguments", "cli.js public arguments"],
      ["batch import tests cover dry-run and invalid input", "batch import dry run invalid tests"],
      ["parseReservation validates each import line", "parseReservation validates line"],
      ["the ledger is the mutation boundary for importBatch", "ledger mutation boundary"],
    ],
    requirement: [
      ["dry-run validates every line without mutating the ledger", "dry run no mutation"],
      ["invalid batch input reports the source line number", "invalid input line number"],
      ["dry-run reports the proposed reservation count", "dry run proposed count"],
    ],
    negative_constraint: [
      ["preserve the public CLI arguments", "preserve CLI arguments"],
      ["preserve the serialized record format", "preserve record format"],
      ["add no dependency and no global cache", "no dependency no global cache"],
      ["do not write the unfinished atomicity task into repository files", "unfinished item chat only"],
    ],
    linkage: [
      ["validating while mutating can leave a partial batch", "validation during mutation causes partial batch"],
      ["a validation pass before mutation makes dry-run safe", "validate before mutation makes dry run safe"],
      ["wrapping parse errors with the index provides source line numbers", "parse error index provides line number"],
      ["dry-run and invalid-batch tests verified the feature", "dry run invalid batch tests verified"],
    ],
    command_test: [
      ["npm test exercised dry-run import", "npm test dry run"],
      ["the no-mutation dry-run assertion passed", "no mutation assertion passed"],
      ["the invalid-line-number assertion passed", "line number assertion passed"],
      ["the complete regression suite passed after phase four", "complete suite passed"],
    ],
    unresolved: [
      ["mixed-validity non-dry-run import must become atomic", "mixed validity import atomic"],
      ["the atomicity item is the single highest-priority next action", "highest priority atomicity"],
      ["tombstone compaction policy remains open but lower priority", "tombstone policy lower priority"],
    ],
    provenance: [
      ["dry-run behavior is backed by the batch import tests", "batch import tests dry run"],
      ["the next action exists only in the phase-four chat record", "next action chat record"],
    ],
  },
];

const expectedCounts = {
  file_symbol: 5,
  requirement: 3,
  negative_constraint: 4,
  linkage: 4,
  command_test: 4,
  unresolved: 3,
  provenance: 2,
};

const prefixes = {
  file_symbol: "FS",
  requirement: "RQ",
  negative_constraint: "NC",
  linkage: "LK",
  command_test: "CT",
  unresolved: "UN",
  provenance: "PV",
};

const responseFields = {
  file_symbol: "files_symbols",
  requirement: "requirements",
  negative_constraint: "negative_constraints",
  linkage: "errors",
  command_test: "commands_tests",
  unresolved: "unresolved",
  provenance: "provenance",
};

const contradictions = new Map([
  ["preserve parseReservation and addReservation signatures", "changed parseReservation and addReservation signatures"],
  ["add no dependency for the parser repair", "added a parser dependency"],
  ["do not rewrite existing ledger history", "chose to rewrite existing ledger history"],
  ["choose decimal-string parsing instead of floating-point multiplication", "kept floating-point multiplication"],
  ["reject a process-global replay cache", "added a process-global replay cache"],
  ["add no runtime dependency for replay", "added a runtime dependency for replay"],
  ["keep replay state local to the ledger operation", "stored replay state globally"],
  ["preserve the phase-one parser and duplicate fixes", "reverted the parser and duplicate fixes"],
  ["do not delete cancelled records", "deleted cancelled records"],
  ["do not rewrite stored reservation records", "rewrote stored reservation records"],
  ["preserve exported report and ledger signatures", "changed exported report and ledger signatures"],
  ["reject history mutation as the cancellation repair", "used history mutation as the cancellation repair"],
  ["preserve the public CLI arguments", "changed the public CLI arguments"],
  ["preserve the serialized record format", "changed the serialized record format"],
  ["add no dependency and no global cache", "added a dependency or global cache"],
  ["do not write the unfinished atomicity task into repository files", "wrote the unfinished atomicity task into repository files"],
]);

const atoms = [];
for (const phase of phases) {
  for (const [category, count] of Object.entries(expectedCounts)) {
    const entries = phase[category];
    if (entries.length !== count) throw new Error(`phase ${phase.phase} ${category}: expected ${count}, got ${entries.length}`);
    entries.forEach(([canonical, alias], index) => {
      const responseField = category === "linkage"
        ? `errors.${index % 2 === 0 ? "cause" : "fix"}`
        : responseFields[category];
      atoms.push({
        id: `P${phase.phase}-${prefixes[category]}-${String(index + 1).padStart(2, "0")}`,
        phase: phase.phase,
        category,
        responseField,
        canonical,
        accepted: [[canonical], [alias]],
        partial: canonical.split(" ").filter((word) => word.length >= 5).slice(0, 3),
        contradictions: contradictions.has(canonical) ? [contradictions.get(canonical)] : [],
        availableAfterCheckpoint: phase.phase,
        continuationCritical: category === "negative_constraint" || category === "unresolved" || category === "linkage",
        observation: { kind: "prompt_or_harness", predicate: `phase-${phase.phase}:${category}:${index + 1}` },
      });
    });
  }
}

if (atoms.length !== 100) throw new Error(`expected 100 atoms, got ${atoms.length}`);
if (new Set(atoms.map((atom) => atom.id)).size !== 100) throw new Error("atom ids must be unique");

const rubric = {
  schemaVersion: 1,
  normalization: ["Unicode NFC", "lowercase en-US", "whitespace collapse", "ASCII punctuation to spaces"],
  exact: "one accepted phrase-set is wholly present in the declared response field",
  partial: "at least one frozen partial token is present but no accepted phrase-set is complete",
  missing: "neither exact nor partial evidence is present",
  contradiction: "a frozen contradiction phrase is present; recall is zero and falseFacts increments",
  points: { exact: 1, partial: 0.5, missing: 0, contradiction: 0 },
  denominator: "25 times checkpoint ordinal",
  target: {
    finalRecall: 0.9,
    maximumCDecay: 0.05,
    cFalseFacts: 0,
    cCriticalExact: 1,
    continuationChecksPassed: 8
  }
};

mkdirSync(outputRoot, { recursive: true });
writeFileSync(resolve(outputRoot, "atoms.json"), `${JSON.stringify(atoms, null, 2)}\n`);
writeFileSync(resolve(outputRoot, "rubric.json"), `${JSON.stringify(rubric, null, 2)}\n`);
