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

test("retries with count round-trip through the URL", () => {
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: 1_000_000_000,
    retries: [
      { success: false, runtimeMS: 100, count: 50 },
      { success: true, runtimeMS: 100 },
    ],
  };
  assert.deepEqual(roundTrip(state), state);
});

test("retries=fail:100*50 decodes to a single entry with count=50", () => {
  const decoded = decodeStateFromParams("?retries=fail:100*50");
  assert.deepEqual(decoded.retries, [{ success: false, runtimeMS: 100, count: 50 }]);
});

test("retries with count=1 omit the *N suffix from the URL", () => {
  const state = {
    ...DEFAULTS,
    retries: [{ success: false, runtimeMS: 100, count: 1 }, { success: true, runtimeMS: 1 }],
  };
  assert.equal(
    encodeStateToParams(state).get("retries"),
    "fail:100,succeed:1"
  );
});

test("malformed retry counts decode to defaults", () => {
  for (const malformed of [
    "?retries=fail:100*0",
    "?retries=fail:100*-5",
    "?retries=fail:100*abc",
    "?retries=fail:100*1.5",
  ]) {
    assert.deepEqual(decodeStateFromParams(malformed).retries, DEFAULTS.retries);
  }
});

test("calculateResult expands count into sequential attempts", () => {
  // 50 failures with default initial interval/backoff, then a success.
  const expandedState = {
    ...DEFAULTS,
    scheduleToCloseTimeout: 1_000_000_000,
    retries: [{ success: false, runtimeMS: 100, count: 50 }, { success: true, runtimeMS: 100 }],
  };
  // The same scenario with each failure spelled out individually.
  const explicitState = {
    ...DEFAULTS,
    scheduleToCloseTimeout: 1_000_000_000,
    retries: [
      ...Array.from({ length: 50 }, () => ({ success: false, runtimeMS: 100 })),
      { success: true, runtimeMS: 100 },
    ],
  };
  assert.deepEqual(calculateResult(expandedState), calculateResult(explicitState));
  assert.equal(calculateResult(expandedState).attempts, 51);
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
  assert.deepEqual(result, { success: true, runtimeMS: 1, attempts: 1 });
});

test("calculateResult: reports the attempt count for a successful chain", () => {
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: 1_000_000_000,
    retries: [
      { success: false, runtimeMS: 10 },
      { success: false, runtimeMS: 10 },
      { success: true, runtimeMS: 10 },
    ],
  };
  assert.equal(calculateResult(state).attempts, 3);
});

test("calculateResult: reports the attempt count when capped by maximumAttempts", () => {
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
  assert.equal(calculateResult(state).attempts, 2);
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

test("calculateResult: failure-only chain with no terminating condition reports infinite retries", () => {
  // No success entry, no maximumAttempts cap, no scheduleToCloseTimeout cap,
  // and per-attempt runtime stays below startToCloseTimeout. The activity
  // would retry indefinitely.
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: 27400,
    retries: [{ success: false, runtimeMS: 10000, count: 10 }],
  };
  const result = calculateResult(state);
  assert.equal(result.success, null);
  assert.equal(result.attempts, Infinity);
  assert.equal(result.reason, "neverTerminates");
});

test("calculateResult: failure-only chain falls back to All retries failed when maximumAttempts is set", () => {
  const state = {
    ...DEFAULTS,
    maximumAttempts: 100, // bounded — chain isn't actually infinite
    retries: [{ success: false, runtimeMS: 1, count: 5 }],
  };
  const result = calculateResult(state);
  assert.equal(result.success, false);
  assert.equal(result.reason, "All retries failed");
});

test("calculateResult: failure-only chain falls back to All retries failed when scheduleToCloseTimeout is set", () => {
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: 1_000_000,
    retries: [{ success: false, runtimeMS: 1, count: 5 }],
  };
  const result = calculateResult(state);
  assert.equal(result.success, false);
  assert.equal(result.reason, "All retries failed");
});

test("calculateResult: scheduleToCloseTimeout=0 does not abort the chain", () => {
  // Regression: a 0 sentinel for scheduleToCloseTimeout used to fire after
  // the first failure (totalRuntimeMS >= 0 is always true). With ∞ semantics
  // the chain should run to completion.
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: 0,
    retries: [
      { success: false, runtimeMS: 100 },
      { success: false, runtimeMS: 100 },
      { success: true, runtimeMS: 100 },
    ],
  };
  const result = calculateResult(state);
  assert.equal(result.success, true);
  assert.equal(result.attempts, 3);
});

test("calculateResult: startToCloseTimeout=0 does not abort the chain", () => {
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: 0,
    scheduleToCloseTimeout: 1_000_000_000,
    retries: [{ success: true, runtimeMS: 5000 }],
  };
  const result = calculateResult(state);
  assert.equal(result.success, true);
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
