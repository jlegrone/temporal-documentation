import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STATE,
  encodeStateToParams,
  decodeStateFromParams,
} from "./retry-simulator-state.mjs";

function roundTrip(state) {
  const decoded = decodeStateFromParams(encodeStateToParams(state).toString());
  return { ...DEFAULT_STATE, ...(decoded ?? {}) };
}

test("default state round-trips to itself", () => {
  assert.deepEqual(roundTrip(DEFAULT_STATE), DEFAULT_STATE);
});

test("default state encodes to no query params", () => {
  assert.equal(encodeStateToParams(DEFAULT_STATE).toString(), "");
});

test("non-default scalars round-trip", () => {
  const state = {
    ...DEFAULT_STATE,
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
    const state = { ...DEFAULT_STATE, language };
    assert.deepEqual(roundTrip(state), state);
  }
});

test("retries round-trip with mixed outcomes", () => {
  const state = {
    ...DEFAULT_STATE,
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
    ...DEFAULT_STATE,
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
    ...DEFAULT_STATE,
    initialInterval: 2500,
    language: "go",
  };
  const params = encodeStateToParams(state);
  assert.deepEqual(
    Array.from(params.keys()).sort(),
    ["initialInterval", "language"]
  );
});

test("malformed params decode to null and yield defaults", () => {
  assert.equal(decodeStateFromParams("?retries=garbage&language=cobol&initialInterval=NaN"), null);
  assert.deepEqual(roundTrip({
    ...DEFAULT_STATE,
    // simulate state already at defaults: round-trip still defaults
  }), DEFAULT_STATE);
});

test("partial params merge over defaults without losing other fields", () => {
  const search = "?initialInterval=2500&language=go";
  const decoded = decodeStateFromParams(search);
  const merged = { ...DEFAULT_STATE, ...decoded };
  assert.deepEqual(merged, {
    ...DEFAULT_STATE,
    initialInterval: 2500,
    language: "go",
  });
});

test("retries=fail:100,fail:200,succeed:50 decodes correctly", () => {
  const decoded = decodeStateFromParams("?retries=fail:100,fail:200,succeed:50");
  assert.deepEqual(decoded?.retries, [
    { success: false, runtimeMS: 100 },
    { success: false, runtimeMS: 200 },
    { success: true, runtimeMS: 50 },
  ]);
});
