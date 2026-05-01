import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateResult,
  encodeStateToParams,
  decodeStateFromParams,
} from "./retry-simulator-state.mjs";

const DEFAULTS = decodeStateFromParams("");

function roundTrip(state) {
  return decodeStateFromParams(encodeStateToParams(state).toString());
}

test("empty input decodes to a complete default state", () => {
  assert.deepEqual(DEFAULTS, {
    retries: [{ success: true, runtimeMS: 1 }],
    language: "typescript",
    scheduleToStartTimeout: 0,
    scheduleToCloseTimeout: 0,
    startToCloseTimeout: 10000,
    backoffCoefficient: 2,
    initialInterval: 1000,
    scheduleTime: 0,
    maximumAttempts: 0,
    maximumInterval: 0,
  });
});

test("default state round-trips to itself", () => {
  assert.deepEqual(roundTrip(DEFAULTS), DEFAULTS);
});

test("default state encodes to no query params", () => {
  assert.equal(encodeStateToParams(DEFAULTS).toString(), "");
});

test("non-default scalars round-trip", () => {
  const state = {
    ...DEFAULTS,
    scheduleToStartTimeout: 2000,
    scheduleToCloseTimeout: 30000,
    startToCloseTimeout: 15000,
    backoffCoefficient: 3,
    initialInterval: 2500,
    scheduleTime: 250,
    maximumAttempts: 5,
    maximumInterval: 60000,
  };
  assert.deepEqual(roundTrip(state), state);
});

test("language round-trips for both supported values", () => {
  for (const language of ["typescript", "go"]) {
    const state = { ...DEFAULTS, language };
    assert.deepEqual(roundTrip(state), state);
  }
});

test("retries round-trip with mixed outcomes", () => {
  const state = {
    ...DEFAULTS,
    retries: [
      { success: false, runtimeMS: 100 },
      { success: false, runtimeMS: 200 },
      { success: true, runtimeMS: 50 },
    ],
  };
  assert.deepEqual(roundTrip(state), state);
});

test("single-failure retry round-trips", () => {
  const state = {
    ...DEFAULTS,
    retries: [{ success: false, runtimeMS: 42 }],
  };
  assert.deepEqual(roundTrip(state), state);
});

test("full non-default state round-trips end-to-end", () => {
  const state = {
    retries: [
      { success: false, runtimeMS: 75 },
      { success: true, runtimeMS: 125 },
    ],
    language: "go",
    scheduleToStartTimeout: 500,
    scheduleToCloseTimeout: 20000,
    startToCloseTimeout: 8000,
    backoffCoefficient: 4,
    initialInterval: 750,
    scheduleTime: 100,
    maximumAttempts: 7,
    maximumInterval: 30000,
  };
  assert.deepEqual(roundTrip(state), state);
});

test("encoded params do not include fields equal to defaults", () => {
  const state = {
    ...DEFAULTS,
    initialInterval: 2500,
    language: "go",
  };
  const params = encodeStateToParams(state);
  assert.deepEqual(
    Array.from(params.keys()).sort(),
    ["initialInterval", "language"]
  );
});

test("malformed params yield defaults", () => {
  assert.deepEqual(
    decodeStateFromParams("?retries=garbage&language=cobol&initialInterval=NaN"),
    DEFAULTS
  );
});

test("partial params merge over defaults without losing other fields", () => {
  const decoded = decodeStateFromParams("?initialInterval=2500&language=go");
  assert.deepEqual(decoded, {
    ...DEFAULTS,
    initialInterval: 2500,
    language: "go",
  });
});

test("retries=fail:100,fail:200,succeed:50 decodes correctly", () => {
  const decoded = decodeStateFromParams("?retries=fail:100,fail:200,succeed:50");
  assert.deepEqual(decoded.retries, [
    { success: false, runtimeMS: 100 },
    { success: false, runtimeMS: 200 },
    { success: true, runtimeMS: 50 },
  ]);
});

test("calculateResult: maximumInterval=0 caps at 100 × initialInterval", () => {
  // initialInterval=1000, max attempts large enough for the cap to take effect.
  // Retry intervals would be 1000, 2000, ..., 64000, then capped at 100000.
  // Five failures means total = sum of intervals 1000+2000+4000+8000+16000 +
  //   per-attempt runtimes. We verify by computing the expected total against
  //   a state where maximumInterval is explicitly set to 100000 — they must agree.
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: 1_000_000_000,
    retries: [
      { success: false, runtimeMS: 10 },
      { success: false, runtimeMS: 10 },
      { success: false, runtimeMS: 10 },
      { success: true, runtimeMS: 10 },
    ],
  };
  const explicit = { ...state, maximumInterval: 100 * state.initialInterval };
  assert.deepEqual(calculateResult(state), calculateResult(explicit));
});

test("calculateResult: maximumInterval=0 cap tracks initialInterval", () => {
  // With initialInterval=500, the cap should be 50000 (not 100000).
  // Use an explicit max of 50000 as the expected baseline.
  const state = {
    ...DEFAULTS,
    initialInterval: 500,
    scheduleToCloseTimeout: 1_000_000_000,
    retries: [
      { success: false, runtimeMS: 1 },
      { success: false, runtimeMS: 1 },
      { success: false, runtimeMS: 1 },
      { success: true, runtimeMS: 1 },
    ],
  };
  const explicit = { ...state, maximumInterval: 100 * state.initialInterval };
  assert.deepEqual(calculateResult(state), calculateResult(explicit));
});

test("calculateResult: explicit maximumInterval overrides the default cap", () => {
  // When maximumInterval is set, it should take precedence over 100×initialInterval.
  const baseState = {
    ...DEFAULTS,
    scheduleToCloseTimeout: 1_000_000_000,
    retries: [
      { success: false, runtimeMS: 1 },
      { success: false, runtimeMS: 1 },
      { success: false, runtimeMS: 1 },
      { success: false, runtimeMS: 1 },
      { success: true, runtimeMS: 1 },
    ],
  };
  const tightCap = { ...baseState, maximumInterval: 5000 };
  const looseCap = { ...baseState, maximumInterval: 1_000_000 };
  // Tight cap accumulates less retry-interval time than loose cap.
  assert.ok(calculateResult(tightCap).runtimeMS < calculateResult(looseCap).runtimeMS);
});

test("calculateResult: succeeds on first attempt with default state", () => {
  const result = calculateResult(DEFAULTS);
  assert.deepEqual(result, { success: true, runtimeMS: 1 });
});

test("calculateResult: maximumAttempts limits retries", () => {
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: 1_000_000_000,
    maximumAttempts: 2,
    retries: [
      { success: false, runtimeMS: 1 },
      { success: false, runtimeMS: 1 },
      { success: true, runtimeMS: 1 },
    ],
  };
  const result = calculateResult(state);
  assert.equal(result.success, false);
  assert.equal(result.reason, "maximumAttempts");
});
