import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Duration,
  calculateResult,
  decodeStateFromParams,
  encodeStateToParams,
  formatDurationHuman,
} from "./retry-simulator-state.mjs";

const DEFAULTS = decodeStateFromParams("");

function roundTrip(state) {
  return decodeStateFromParams(encodeStateToParams(state).toString());
}

test("empty input decodes to a complete default state", () => {
  assert.deepEqual(DEFAULTS, {
    retries: [{ success: true, runtime: new Duration(1, "s") }],
    language: "typescript",
    scheduleToStartTimeout: new Duration(0, "s"),
    scheduleToCloseTimeout: new Duration(24, "h"),
    startToCloseTimeout: new Duration(0, "s"),
    backoffCoefficient: 2,
    initialInterval: new Duration(1, "s"),
    scheduleTime: new Duration(0, "s"),
    maximumAttempts: 0,
    // SDK default: 100 × initialInterval (matches the docs at
    // https://docs.temporal.io/encyclopedia/retry-policies#default-values-for-retry-policy).
    maximumInterval: new Duration(100, "s"),
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
    scheduleToStartTimeout: new Duration(2, "s"),
    scheduleToCloseTimeout: new Duration(30, "s"),
    startToCloseTimeout: new Duration(15, "s"),
    backoffCoefficient: 3,
    initialInterval: new Duration(2500, "ms"),
    scheduleTime: new Duration(250, "ms"),
    maximumAttempts: 5,
    maximumInterval: new Duration(60, "s"),
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
      { success: false, runtime: new Duration(100, "ms") },
      { success: false, runtime: new Duration(200, "ms") },
      { success: true, runtime: new Duration(50, "ms") },
    ],
  };
  assert.deepEqual(roundTrip(state), state);
});

test("single-failure retry round-trips", () => {
  const state = {
    ...DEFAULTS,
    retries: [{ success: false, runtime: new Duration(42, "ms") }],
  };
  assert.deepEqual(roundTrip(state), state);
});

test("full non-default state round-trips end-to-end", () => {
  const state = {
    retries: [
      { success: false, runtime: new Duration(75, "ms") },
      { success: true, runtime: new Duration(125, "ms") },
    ],
    language: "go",
    scheduleToStartTimeout: new Duration(500, "ms"),
    scheduleToCloseTimeout: new Duration(20, "s"),
    startToCloseTimeout: new Duration(8, "s"),
    backoffCoefficient: 4,
    initialInterval: new Duration(750, "ms"),
    scheduleTime: new Duration(100, "ms"),
    maximumAttempts: 7,
    maximumInterval: new Duration(30, "s"),
  };
  assert.deepEqual(roundTrip(state), state);
});

test("encoded params omit maximumInterval when it matches 100 × initialInterval", () => {
  // A non-default initialInterval combined with the matching SDK-default
  // maximumInterval should still leave maximumInterval out of the URL.
  const state = {
    ...DEFAULTS,
    initialInterval: new Duration(2500, "ms"),
    maximumInterval: new Duration(250, "s"), // 100 × 2500 ms = 250000 ms
    language: "go",
  };
  const params = encodeStateToParams(state);
  assert.deepEqual(
    Array.from(params.keys()).sort(),
    ["initialInterval", "language"]
  );
});

test("each numeric field round-trips in isolation", () => {
  // For every numeric/duration field, swap the default for a non-default
  // value, encode, decode, and confirm the value survives. This catches
  // wrong-variable bugs in encode/decode that fixed-shape tests miss.
  const cases = [
    { field: "scheduleToStartTimeout", value: new Duration(2, "s") },
    { field: "scheduleToCloseTimeout", value: new Duration(45, "m") },
    { field: "startToCloseTimeout", value: new Duration(15, "s") },
    { field: "backoffCoefficient", value: 4 },
    { field: "initialInterval", value: new Duration(2500, "ms") },
    { field: "scheduleTime", value: new Duration(250, "ms") },
    { field: "maximumAttempts", value: 5 },
    { field: "maximumInterval", value: new Duration(60, "s") },
  ];
  for (const { field, value } of cases) {
    const state = { ...DEFAULTS, [field]: value };
    const decoded = roundTrip(state);
    if (value instanceof Duration) {
      assert.ok(
        decoded[field] instanceof Duration,
        `${field}: decoded value should be a Duration`
      );
      assert.equal(
        decoded[field].toMilliseconds(),
        value.toMilliseconds(),
        `${field}: ms value mismatch after round-trip`
      );
      assert.equal(decoded[field].unit, value.unit, `${field}: unit mismatch after round-trip`);
    } else {
      assert.equal(decoded[field], value, `${field}: value mismatch after round-trip`);
    }
  }
});

test("encoded params include maximumInterval when it diverges from the default", () => {
  const state = {
    ...DEFAULTS,
    initialInterval: new Duration(2500, "ms"),
    maximumInterval: new Duration(12345, "ms"),
  };
  const params = encodeStateToParams(state);
  assert.equal(params.get("maximumInterval"), "12345ms");
});

test("durations are encoded as <count><unit>", () => {
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(24, "h"),
    startToCloseTimeout: new Duration(15, "s"),
    initialInterval: new Duration(2500, "ms"),
    maximumInterval: new Duration(250, "s"),
  };
  const params = encodeStateToParams(state);
  assert.equal(params.get("startToCloseTimeout"), "15s");
  assert.equal(params.get("initialInterval"), "2500ms");
});

test("malformed params yield defaults", () => {
  assert.deepEqual(
    decodeStateFromParams("?retries=garbage&language=cobol&initialInterval=NaN"),
    DEFAULTS
  );
});

test("partial params merge over defaults — maximumInterval tracks decoded initialInterval", () => {
  const decoded = decodeStateFromParams("?initialInterval=2500ms&language=go");
  assert.deepEqual(decoded, {
    ...DEFAULTS,
    initialInterval: new Duration(2500, "ms"),
    maximumInterval: new Duration(250000, "ms"), // 100 × 2500 ms; unit inherited from initialInterval
    language: "go",
  });
});

test("explicit maximumInterval in URL overrides the computed default", () => {
  const decoded = decodeStateFromParams("?initialInterval=500ms&maximumInterval=10s");
  assert.equal(decoded.maximumInterval.toMilliseconds(), 10000);
  assert.equal(decoded.maximumInterval.unit, "s");
});

test("retries with count round-trip through the URL", () => {
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(1_000_000_000, "ms"),
    retries: [
      { success: false, runtime: new Duration(100, "ms"), count: 50 },
      { success: true, runtime: new Duration(100, "ms") },
    ],
  };
  assert.deepEqual(roundTrip(state), state);
});

test("retries=fail:100*50 decodes to a single entry with count=50", () => {
  const decoded = decodeStateFromParams("?retries=fail:100*50");
  assert.deepEqual(decoded.retries, [
    { success: false, runtime: new Duration(100, "ms"), count: 50 },
  ]);
});

test("retries with count=1 omit the *N suffix from the URL", () => {
  const state = {
    ...DEFAULTS,
    retries: [
      { success: false, runtime: new Duration(100, "ms"), count: 1 },
      { success: true, runtime: new Duration(1, "ms") },
    ],
  };
  assert.equal(encodeStateToParams(state).get("retries"), "fail:100ms,succeed:1ms");
});

test("retries can carry per-entry duration units", () => {
  const decoded = decodeStateFromParams("?retries=fail:1.5s*3,succeed:200ms");
  assert.deepEqual(decoded.retries, [
    { success: false, runtime: new Duration(1.5, "s"), count: 3 },
    { success: true, runtime: new Duration(200, "ms") },
  ]);
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
  const expandedState = {
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(1_000_000_000, "ms"),
    retries: [
      { success: false, runtime: new Duration(100, "ms"), count: 50 },
      { success: true, runtime: new Duration(100, "ms") },
    ],
  };
  const explicitState = {
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(1_000_000_000, "ms"),
    retries: [
      ...Array.from({ length: 50 }, () => ({
        success: false,
        runtime: new Duration(100, "ms"),
      })),
      { success: true, runtime: new Duration(100, "ms") },
    ],
  };
  assert.deepEqual(calculateResult(expandedState), calculateResult(explicitState));
  assert.equal(calculateResult(expandedState).attempts, 51);
});

test("retries=fail:100,fail:200,succeed:50 decodes correctly (legacy bare-ms format)", () => {
  const decoded = decodeStateFromParams("?retries=fail:100,fail:200,succeed:50");
  assert.deepEqual(decoded.retries, [
    { success: false, runtime: new Duration(100, "ms") },
    { success: false, runtime: new Duration(200, "ms") },
    { success: true, runtime: new Duration(50, "ms") },
  ]);
});

test("calculateResult: succeeds on first attempt with default state", () => {
  const result = calculateResult(DEFAULTS);
  assert.deepEqual(result, { success: true, runtimeMS: 1000, attempts: 1 });
});

test("calculateResult: reports the attempt count for a successful chain", () => {
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(1_000_000_000, "ms"),
    retries: [
      { success: false, runtime: new Duration(10, "ms") },
      { success: false, runtime: new Duration(10, "ms") },
      { success: true, runtime: new Duration(10, "ms") },
    ],
  };
  assert.equal(calculateResult(state).attempts, 3);
});

test("calculateResult: reports the attempt count when capped by maximumAttempts", () => {
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(1_000_000_000, "ms"),
    maximumAttempts: 2,
    retries: [
      { success: false, runtime: new Duration(1, "ms") },
      { success: false, runtime: new Duration(1, "ms") },
      { success: true, runtime: new Duration(1, "ms") },
    ],
  };
  assert.equal(calculateResult(state).attempts, 2);
});

test("calculateResult: maximumInterval caps the retry interval growth", () => {
  const baseState = {
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(1_000_000_000, "ms"),
    retries: [
      { success: false, runtime: new Duration(1, "ms") },
      { success: false, runtime: new Duration(1, "ms") },
      { success: false, runtime: new Duration(1, "ms") },
      { success: false, runtime: new Duration(1, "ms") },
      { success: true, runtime: new Duration(1, "ms") },
    ],
  };
  const tightCap = { ...baseState, maximumInterval: new Duration(5, "s") };
  const looseCap = { ...baseState, maximumInterval: new Duration(1_000_000, "ms") };
  assert.ok(calculateResult(tightCap).runtimeMS < calculateResult(looseCap).runtimeMS);
});

test("calculateResult: failure-only chain with no terminating condition reports infinite retries", () => {
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: new Duration(27400, "ms"),
    scheduleToCloseTimeout: new Duration(0, "s"),
    retries: [{ success: false, runtime: new Duration(10000, "ms"), count: 10 }],
  };
  const result = calculateResult(state);
  assert.equal(result.success, null);
  assert.equal(result.attempts, Infinity);
  assert.equal(result.reason, "neverTerminates");
});

test("calculateResult: projects beyond configured failures until maximumAttempts fires", () => {
  // 5 configured failures; the simulator should keep projecting failures until
  // it actually hits the maximumAttempts cap.
  const state = {
    ...DEFAULTS,
    maximumAttempts: 100,
    retries: [{ success: false, runtime: new Duration(1, "ms"), count: 5 }],
  };
  const result = calculateResult(state);
  assert.equal(result.success, false);
  assert.equal(result.reason, "maximumAttempts");
  assert.equal(result.attempts, 100);
});

test("calculateResult: projects beyond configured failures until scheduleToCloseTimeout fires", () => {
  // 5 configured failures; with maximumAttempts unbounded, we project until
  // the scheduleToCloseTimeout actually closes the chain.
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(1_000_000, "ms"),
    retries: [{ success: false, runtime: new Duration(1, "ms"), count: 5 }],
  };
  const result = calculateResult(state);
  assert.equal(result.success, false);
  assert.equal(result.reason, "scheduleToCloseTimeout");
  assert.ok(result.attempts > 5);
});

test("calculateResult: scheduleToCloseTimeout=0 does not abort the chain", () => {
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(0, "s"),
    retries: [
      { success: false, runtime: new Duration(100, "ms") },
      { success: false, runtime: new Duration(100, "ms") },
      { success: true, runtime: new Duration(100, "ms") },
    ],
  };
  const result = calculateResult(state);
  assert.equal(result.success, true);
  assert.equal(result.attempts, 3);
});

test("calculateResult: startToCloseTimeout=0 does not abort the chain", () => {
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: new Duration(0, "s"),
    scheduleToCloseTimeout: new Duration(1_000_000_000, "ms"),
    retries: [{ success: true, runtime: new Duration(5000, "ms") }],
  };
  const result = calculateResult(state);
  assert.equal(result.success, true);
});

test("calculateResult: runtime > startToCloseTimeout treats each attempt as a per-attempt timeout but retry continues", () => {
  // Temporal's startToCloseTimeout is per-attempt. An attempt that would run
  // longer than the timeout is killed by the Server, counted as a failure,
  // and the retry policy schedules another. Here every attempt times out, so
  // the simulation runs until maximumAttempts caps the chain.
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: new Duration(50, "ms"),
    maximumAttempts: 3,
    retries: [{ success: false, runtime: new Duration(100, "ms") }],
  };
  const result = calculateResult(state);
  assert.equal(result.success, false);
  assert.equal(result.reason, "maximumAttempts");
  assert.equal(result.attempts, 3);
});

test("calculateResult: a configured success that exceeds startToCloseTimeout is treated as a timed-out failure", () => {
  // Even if the user marks the attempt as a success, Temporal kills it at
  // the per-attempt timeout and the retry policy continues.
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: new Duration(50, "ms"),
    maximumAttempts: 2,
    retries: [{ success: true, runtime: new Duration(100, "ms") }],
  };
  const result = calculateResult(state);
  assert.equal(result.success, false);
  assert.equal(result.reason, "maximumAttempts");
});

test("calculateResult: per-attempt timeout caps elapsed time at startToCloseTimeout", () => {
  // Attempt's wall-clock contribution is min(runtime, startToCloseTimeout).
  // initialInterval=1s, backoff=2 → first retry interval is 2s, second is 4s.
  // 3 timed-out attempts at 50ms each + 2s + 4s = 6150ms total.
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: new Duration(50, "ms"),
    maximumAttempts: 3,
    retries: [{ success: false, runtime: new Duration(10000, "ms") }],
  };
  const result = calculateResult(state);
  assert.equal(result.runtimeMS, 50 + 2000 + 50 + 4000 + 50);
});

test("calculateResult: per-attempt runtime < startToCloseTimeout proceeds normally", () => {
  // Runtime stays under the cap, so the simulation should succeed.
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: new Duration(1000, "ms"),
    retries: [{ success: true, runtime: new Duration(100, "ms") }],
  };
  const result = calculateResult(state);
  assert.equal(result.success, true);
});

test("calculateResult: scheduleTime ≥ scheduleToStartTimeout returns scheduleTime reason", () => {
  const state = {
    ...DEFAULTS,
    scheduleToStartTimeout: new Duration(100, "ms"),
    scheduleTime: new Duration(150, "ms"),
  };
  const result = calculateResult(state);
  assert.equal(result.success, false);
  assert.equal(result.reason, "scheduleTime");
  assert.equal(result.attempts, 0);
});

test("calculateResult: scheduleTime < scheduleToStartTimeout does not bail out", () => {
  const state = {
    ...DEFAULTS,
    scheduleToStartTimeout: new Duration(1000, "ms"),
    scheduleTime: new Duration(50, "ms"),
  };
  const result = calculateResult(state);
  assert.equal(result.success, true);
});

test("calculateResult: scheduleToStartTimeout=0 ignores scheduleTime entirely", () => {
  const state = {
    ...DEFAULTS,
    scheduleToStartTimeout: new Duration(0, "s"),
    scheduleTime: new Duration(60, "m"),
  };
  const result = calculateResult(state);
  assert.equal(result.success, true);
});

test("calculateResult: scheduleTime exactly equal to scheduleToStartTimeout still bails out", () => {
  // Boundary case for the >= comparison.
  const state = {
    ...DEFAULTS,
    scheduleToStartTimeout: new Duration(100, "ms"),
    scheduleTime: new Duration(100, "ms"),
  };
  const result = calculateResult(state);
  assert.equal(result.success, false);
  assert.equal(result.reason, "scheduleTime");
});

test("calculateResult: per-attempt runtime exactly equal to startToCloseTimeout still times the attempt out", () => {
  // Boundary case for the >= comparison: at equality the attempt is killed.
  // With maxAttempts=1 the chain ends immediately as a timed-out failure.
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: new Duration(100, "ms"),
    maximumAttempts: 1,
    retries: [{ success: true, runtime: new Duration(100, "ms") }],
  };
  const result = calculateResult(state);
  assert.equal(result.success, false);
  assert.equal(result.reason, "maximumAttempts");
  assert.equal(result.runtimeMS, 100);
});

test("calculateResult: totalRuntimeMS exactly equal to scheduleToCloseTimeout still bails out on that attempt", () => {
  // Boundary case for the >= comparison on accumulated runtime.
  // After attempt 1: runtime 1000 ms + retry interval 2000 ms (initialInterval
  // × backoffCoefficient) = exactly 3000 ms, matching scheduleToCloseTimeout.
  // The cap should fire here (attempts=1), not on a later iteration where
  // totalRuntimeMS strictly exceeds the cap.
  const state = {
    ...DEFAULTS,
    initialInterval: new Duration(1, "s"),
    scheduleToCloseTimeout: new Duration(3000, "ms"),
    retries: [
      { success: false, runtime: new Duration(1, "s") },
      { success: false, runtime: new Duration(1, "s") },
    ],
  };
  const result = calculateResult(state);
  assert.equal(result.success, false);
  assert.equal(result.reason, "scheduleToCloseTimeout");
  assert.equal(result.attempts, 1);
});

test("calculateResult: maximumAttempts limits retries", () => {
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(1_000_000_000, "ms"),
    maximumAttempts: 2,
    retries: [
      { success: false, runtime: new Duration(1, "ms") },
      { success: false, runtime: new Duration(1, "ms") },
      { success: true, runtime: new Duration(1, "ms") },
    ],
  };
  const result = calculateResult(state);
  assert.equal(result.success, false);
  assert.equal(result.reason, "maximumAttempts");
});

test("Duration: toMilliseconds converts correctly across units", () => {
  assert.equal(new Duration(1, "ms").toMilliseconds(), 1);
  assert.equal(new Duration(1, "s").toMilliseconds(), 1000);
  assert.equal(new Duration(1, "m").toMilliseconds(), 60_000);
  assert.equal(new Duration(1, "h").toMilliseconds(), 3_600_000);
  assert.equal(new Duration(2.5, "s").toMilliseconds(), 2500);
});

test("Duration.parse accepts <count><unit> strings", () => {
  assert.deepEqual(Duration.parse("1500ms"), new Duration(1500, "ms"));
  assert.deepEqual(Duration.parse("24h"), new Duration(24, "h"));
  assert.deepEqual(Duration.parse("0.5s"), new Duration(0.5, "s"));
  assert.equal(Duration.parse("invalid"), null);
  assert.equal(Duration.parse("100"), null);
  assert.equal(Duration.parse("100xyz"), null);
});

test("formatDurationHuman picks the largest natural unit", () => {
  assert.equal(formatDurationHuman(0), "0ms");
  assert.equal(formatDurationHuman(1), "1ms");
  assert.equal(formatDurationHuman(999), "999ms");
  assert.equal(formatDurationHuman(1000), "1s");
  assert.equal(formatDurationHuman(1500), "1.5s");
  assert.equal(formatDurationHuman(5100), "5.1s");
  assert.equal(formatDurationHuman(60_000), "1m");
  assert.equal(formatDurationHuman(90_000), "1.5m");
  assert.equal(formatDurationHuman(3_600_000), "1h");
  assert.equal(formatDurationHuman(86_400_000), "24h");
});

test("Duration.withUnit keeps the numeric value and changes the unit", () => {
  const d = new Duration(1500, "ms");
  assert.equal(d.withUnit("s").value, 1500);
  assert.equal(d.withUnit("s").toMilliseconds(), 1_500_000);
});
