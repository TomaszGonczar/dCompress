import assert from "node:assert/strict";
import test from "node:test";

import { clamp } from "./math.js";

test("clamp preserves values inside the range", () => {
  assert.equal(clamp(5, 1, 10), 5);
});

test("clamp rejects an inverted range", () => {
  assert.throws(() => clamp(5, 10, 1), /minimum must not exceed maximum/);
});
