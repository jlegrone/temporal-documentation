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
    // SDK default: 100 × initialInterval (matches the docs at
    // https://docs.temporal.io/encyclopedia/retry-policies#default-values-for-retry-policy).
    maximumInterval: 100000,
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

test("encoded params omit maximumInterval when it matches 100 × initialInterval", () => {
  // A non-default initialInterval combined with the matching SDK-default
  // maximumInterval should still leave maximumInterval out of the URL.
  const state = {
    ...DEFAULTS,
    initialInterval: 2500,
    maximumInterval: 100 * 2500,
    language: "go",
  };
  const params = encodeStateToParams(state);
  assert.deepEqual(
    Array.from(params.keys()).sort(),
    ["initialInterval", "language"]
  );
});

test("encoded params include maximumInterval when it diverges from the default", () => {
  const state = { ...DEFAULTS, initialInterval: 2500, maximumInterval: 12345 };
  const params = encodeStateToParams(state);
  assert.equal(params.get("maximumInterval"), "12345");
});

test("malformed params yield defaults", () => {
  assert.deepEqual(
    decodeStateFromParams("?retries=garbage&language=cobol&initialInterval=NaN"),
    DEFAULTS
  );
});

test("partial params merge over defaults — maximumInterval tracks decoded initialInterval", () => {
  const decoded = decodeStateFromParams("?initialInterval=2500&language=go");
  assert.deepEqual(decoded, {
    ...DEFAULTS,
    initialInterval: 2500,
    maximumInterval: 100 * 2500,
    language: "go",
  });
});

test("explicit maximumInterval in URL overrides the computed default", () => {
  const decoded = decodeStateFromParams("?initialInterval=500&maximumInterval=10000");
  assert.equal(decoded.maximumInterval, 10000);
});

test("retries=fail:100,fail:200,succeed:50 decodes correctly", () => {
  const decoded = decodeStateFromParams("?retries=fail:100,fail:200,succeed:50");
  assert.deepEqual(decoded.retries, [
    { success: false, runtimeMS: 100 },
    { success: false, runtimeMS: 200 },
    { success: true, runtimeMS: 50 },
  ]);
});

test("calculateResult: succeeds on first attempt with default state", () => {
  const result = calculateResult(DEFAULTS);
  assert.deepEqual(result, { success: true, runtimeMS: 1 });
});

test("calculateResult: maximumInterval caps the retry interval growth", () => {
  // Tight cap accumulates less retry-interval time than a loose one.
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
  assert.ok(calculateResult(tightCap).runtimeMS < calculateResult(looseCap).runtimeMS);
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
