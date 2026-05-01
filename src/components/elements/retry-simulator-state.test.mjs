import { test } from "node:test";
import assert from "node:assert/strict";
import {
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
