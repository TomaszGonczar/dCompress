import assert from "node:assert/strict";
import test from "node:test";

import { addReservation, createLedger } from "../src/ledger.js";
import { parseReservation } from "../src/parser.js";

test("parses decimal prices into exact integer cents", () => {
  assert.deepEqual(parseReservation("r-1|Ada|10.12"), {
    id: "r-1", guest: "Ada", cents: 1012, status: "active",
  });
});

test("rejects duplicate reservation ids without rewriting history", () => {
  const original = { id: "r-1", guest: "Ada", cents: 1010, status: "active" };
  const ledger = createLedger([original]);
  assert.throws(
    () => addReservation(ledger, { ...original, guest: "Grace" }),
    /duplicate reservation: r-1/,
  );
  assert.deepEqual(ledger.records, [original]);
});

test("keeps the public JSON record shape stable", () => {
  assert.equal(JSON.stringify(parseReservation("r-2|Lin|7.25")),
    '{"id":"r-2","guest":"Lin","cents":725,"status":"active"}');
});
