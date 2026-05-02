import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Duration,
  calculateResult,
  crashLoopAttempts,
  decodeStateFromParams,
  encodeStateToParams,
  formatDurationHuman,
  formatDurationLong,
  zeroDelayExhaustionMS,
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
    heartbeatTimeout: new Duration(0, "s"),
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

test("default state encodes every field unconditionally", () => {
  // The encoder always writes every field — including ones that match the
  // default — so the URL fully describes the configuration the user sees.
  const params = encodeStateToParams(DEFAULTS);
  assert.deepEqual(
    Array.from(params.keys()).sort(),
    [
      "backoffCoefficient",
      "heartbeatTimeout",
      "initialInterval",
      "language",
      "maximumAttempts",
      "maximumInterval",
      "retries",
      "scheduleTime",
      "scheduleToCloseTimeout",
      "scheduleToStartTimeout",
      "startToCloseTimeout",
    ]
  );
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
    heartbeatTimeout: new Duration(2, "s"),
    backoffCoefficient: 4,
    initialInterval: new Duration(750, "ms"),
    scheduleTime: new Duration(100, "ms"),
    maximumAttempts: 7,
    maximumInterval: new Duration(30, "s"),
  };
  assert.deepEqual(roundTrip(state), state);
});

test("encoded params include maximumInterval even when it matches 100 × initialInterval", () => {
  // The encoder writes every field unconditionally — defaults are no longer
  // elided — so an SDK-default maximumInterval still lands in the URL.
  const state = {
    ...DEFAULTS,
    initialInterval: new Duration(2500, "ms"),
    maximumInterval: new Duration(250, "s"), // 100 × 2500 ms = 250000 ms
    language: "go",
  };
  const params = encodeStateToParams(state);
  assert.equal(params.get("initialInterval"), "2500ms");
  assert.equal(params.get("maximumInterval"), "250s");
  assert.equal(params.get("language"), "go");
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

test("retries with count=1 omit the attempts suffix from the URL", () => {
  const state = {
    ...DEFAULTS,
    retries: [
      { success: false, runtime: new Duration(100, "ms"), count: 1 },
      { success: true, runtime: new Duration(1, "ms") },
    ],
  };
  assert.equal(
    encodeStateToParams(state).get("retries"),
    "fail:after:100ms,succeed:after:1ms"
  );
});

test("retries encode the new self-describing format with attempts", () => {
  const state = {
    ...DEFAULTS,
    retries: [
      { success: false, runtime: new Duration(100, "ms"), count: 50 },
      { success: true, runtime: new Duration(1, "s") },
    ],
  };
  assert.equal(
    encodeStateToParams(state).get("retries"),
    "fail:after:100ms:attempts:50,succeed:after:1s"
  );
});

test("retries with period round-trip through the URL", () => {
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(1_000_000_000, "ms"),
    retries: [
      { success: false, runtime: new Duration(100, "ms"), period: new Duration(30, "m") },
      { success: true, runtime: new Duration(50, "ms") },
    ],
  };
  assert.deepEqual(roundTrip(state), state);
});

test("retries period segment encodes as :period:<duration>", () => {
  const state = {
    ...DEFAULTS,
    retries: [
      { success: false, runtime: new Duration(100, "ms"), period: new Duration(30, "m") },
      { success: true, runtime: new Duration(50, "ms") },
    ],
  };
  assert.equal(
    encodeStateToParams(state).get("retries"),
    "fail:after:100ms:period:30m,succeed:after:50ms"
  );
});

test("legacy retry URL format still decodes (positional, *count)", () => {
  const decoded = decodeStateFromParams("?retries=fail:100*5,succeed:50");
  assert.deepEqual(decoded.retries, [
    { success: false, runtime: new Duration(100, "ms"), count: 5 },
    { success: true, runtime: new Duration(50, "ms") },
  ]);
});

test("malformed retry URLs reject unknown keys", () => {
  for (const malformed of [
    "?retries=fail:after:100ms:bogus:1",
    "?retries=fail:after:100ms:attempts",
    "?retries=fail:after:100ms:period:0s",
    "?retries=fail:after:100ms:attempts:50:period:30m",
  ]) {
    assert.deepEqual(decodeStateFromParams(malformed).retries, DEFAULTS.retries);
  }
});

test("calculateResult: failure period bounds an outage window", () => {
  // 30 minutes of failures, then a success. With initialInterval=1s, backoff=2,
  // maximumInterval=100s, the chain runs many timed retries until the period
  // ends, after which the next entry's success returns. The success attempts
  // count = total attempts inside the window + 1 success.
  const state = {
    ...DEFAULTS,
    retries: [
      { success: false, runtime: new Duration(100, "ms"), period: new Duration(30, "m") },
      { success: true, runtime: new Duration(50, "ms") },
    ],
  };
  const result = calculateResult(state);
  assert.equal(result.success, true);
  assert.ok(result.runtimeMS >= 30 * 60 * 1000); // at least 30 minutes elapsed
  assert.ok(result.attempts > 1);
});

test("calculateResult: success period with runtime > startToCloseTimeout produces timed-out attempts then exits", () => {
  // For 2 minutes the latency is 5s, but startToCloseTimeout=2s kills every
  // attempt. After the period elapses the next entry's quick success returns.
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: new Duration(2, "s"),
    retries: [
      { success: true, runtime: new Duration(5, "s"), period: new Duration(2, "m") },
      { success: true, runtime: new Duration(50, "ms") },
    ],
  };
  const result = calculateResult(state);
  assert.equal(result.success, true);
  // Should take at least 2 minutes (the latency window) before the success.
  assert.ok(result.runtimeMS >= 2 * 60 * 1000);
});

test("calculateResult: count and period together stop on whichever fires first", () => {
  // count=1000 is huge; period=10s should be the binding limit.
  const state = {
    ...DEFAULTS,
    retries: [
      {
        success: false,
        runtime: new Duration(10, "ms"),
        count: 1000,
        period: new Duration(10, "s"),
      },
      { success: true, runtime: new Duration(50, "ms") },
    ],
  };
  const result = calculateResult(state);
  assert.equal(result.success, true);
  // Period bounded the failure phase, so we shouldn't have run anywhere near
  // 1000 attempts before the success.
  assert.ok(result.attempts < 50, `expected < 50 attempts, got ${result.attempts}`);
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
  assert.deepEqual(result, {
    success: true,
    runtimeMS: 1000,
    attempts: 1,
    lastAttemptOutcome: "succeeded",
    attemptTimeline: [{ startMS: 0, elapsedMS: 1000, outcome: "succeeded" }],
  });
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

test("calculateResult: scheduleToCloseTimeout caps reported runtimeMS at the timeout", () => {
  // When a retry interval would push the simulation past scheduleToCloseTimeout,
  // Temporal fails the execution at the deadline — not at deadline + interval.
  // Verify the reported runtimeMS reflects the actual failure point.
  const state = {
    ...DEFAULTS,
    initialInterval: new Duration(1, "s"),
    backoffCoefficient: 10,
    scheduleToCloseTimeout: new Duration(5, "s"),
    retries: [{ success: false, runtime: new Duration(1, "s") }],
  };
  const result = calculateResult(state);
  assert.equal(result.success, false);
  assert.equal(result.reason, "scheduleToCloseTimeout");
  assert.equal(result.runtimeMS, 5000);
});

test("calculateResult: a single attempt that overshoots scheduleToCloseTimeout records one truncated 'timedOut' bar", () => {
  // The pre-attempt cap must consider attemptStartMS + attemptElapsed, not
  // attemptStartMS alone — otherwise a 10s attempt against a 5s deadline
  // records its full untruncated bar and appends a ghost past the deadline.
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(5, "s"),
    retries: [{ success: false, runtime: new Duration(10, "s") }],
  };
  const result = calculateResult(state);
  assert.equal(result.attemptTimeline.length, 1);
  assert.deepEqual(result.attemptTimeline[0], {
    startMS: 0,
    elapsedMS: 5000,
    outcome: "timedOut",
  });
  assert.equal(result.reason, "scheduleToCloseTimeout");
});

test("calculateResult: an attempt that lands exactly on scheduleToCloseTimeout still records as timedOut", () => {
  // Boundary case for the >= comparison on attemptStartMS + attemptElapsed.
  // A 1s attempt against a 1s deadline ends at exactly the deadline — the
  // Server still kills it at scheduleToCloseTimeout, so the bar must be
  // labeled "timedOut", not allowed to complete normally.
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(1, "s"),
    retries: [{ success: false, runtime: new Duration(1, "s") }],
  };
  const result = calculateResult(state);
  assert.equal(result.attemptTimeline.length, 1);
  assert.deepEqual(result.attemptTimeline[0], {
    startMS: 0,
    elapsedMS: 1000,
    outcome: "timedOut",
  });
  assert.equal(result.reason, "scheduleToCloseTimeout");
  assert.equal(result.runtimeMS, 1000);
});

test("calculateResult: a later attempt that overshoots scheduleToCloseTimeout truncates at the remaining budget", () => {
  // Same defect class as the first-attempt case, but with a non-zero
  // attemptStartMS so the cappedElapsed = scheduleToCloseTimeout - attemptStartMS
  // arithmetic is exercised. First attempt: 1s runtime + 2s retry interval
  // (initialInterval × backoffCoefficient) = 3s consumed; second attempt would
  // run 10s but only 2s remain before the 5s deadline.
  const state = {
    ...DEFAULTS,
    initialInterval: new Duration(1, "s"),
    backoffCoefficient: 2,
    scheduleToCloseTimeout: new Duration(5, "s"),
    retries: [
      { success: false, runtime: new Duration(1, "s") },
      { success: false, runtime: new Duration(10, "s") },
    ],
  };
  const result = calculateResult(state);
  assert.equal(result.attemptTimeline.length, 2);
  assert.deepEqual(result.attemptTimeline[1], {
    startMS: 3000,
    elapsedMS: 2000,
    outcome: "timedOut",
  });
  assert.equal(result.reason, "scheduleToCloseTimeout");
  assert.equal(result.runtimeMS, 5000);
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

test("formatDurationLong renders two most significant non-zero units", () => {
  assert.equal(formatDurationLong(0), "0 seconds");
  assert.equal(formatDurationLong(1), "1 millisecond");
  assert.equal(formatDurationLong(500), "500 milliseconds");
  assert.equal(formatDurationLong(1000), "1 second");
  assert.equal(formatDurationLong(1500), "1 second 500 milliseconds");
  assert.equal(formatDurationLong(60_000), "1 minute");
  assert.equal(formatDurationLong(90_000), "1 minute 30 seconds");
  assert.equal(formatDurationLong(150_000), "2 minutes 30 seconds");
  assert.equal(formatDurationLong(3_600_000), "1 hour");
  assert.equal(formatDurationLong(3_660_000), "1 hour 1 minute");
  assert.equal(formatDurationLong(86_400_000), "24 hours");
  // Skips middle zero unit when picking the two most significant components.
  assert.equal(formatDurationLong(60_001), "1 minute 1 millisecond");
});

test("Duration.withUnit keeps the numeric value and changes the unit", () => {
  const d = new Duration(1500, "ms");
  assert.equal(d.withUnit("s").value, 1500);
  assert.equal(d.withUnit("s").toMilliseconds(), 1_500_000);
});

test("calculateResult returns attemptTimeline with monotonic startMS", () => {
  const state = {
    ...DEFAULTS,
    initialInterval: new Duration(1, "s"),
    backoffCoefficient: 2,
    scheduleToCloseTimeout: new Duration(1_000_000, "ms"),
    retries: [
      { success: false, runtime: new Duration(100, "ms") },
      { success: false, runtime: new Duration(100, "ms") },
      { success: true, runtime: new Duration(100, "ms") },
    ],
  };
  const result = calculateResult(state);
  const tl = result.attemptTimeline;
  // No ghost on a successful chain — the activity reported success, no
  // retry was suppressed by a limit.
  assert.equal(tl.length, 3);
  // Monotonic non-decreasing startMS, each follows the previous attempt + retry interval.
  assert.equal(tl[0].startMS, 0);
  assert.ok(tl[1].startMS > tl[0].startMS + tl[0].elapsedMS);
  assert.ok(tl[2].startMS > tl[1].startMS + tl[1].elapsedMS);
  assert.deepEqual(
    tl.map((a) => a.outcome),
    ["failed", "failed", "succeeded"]
  );
  // Final entry's end matches the reported runtimeMS for terminal success.
  const last = tl[tl.length - 1];
  assert.equal(last.startMS + last.elapsedMS, result.runtimeMS);
});

test("calculateResult: attemptTimeline elapsedMS clamps at startToCloseTimeout", () => {
  // Each attempt's runtime is 5s but startToCloseTimeout caps at 2s; every
  // real attempt should record elapsedMS=2000 with outcome "timedOut", plus
  // a notUsed ghost at the end showing where attempt 4 would have been.
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: new Duration(2, "s"),
    initialInterval: new Duration(1, "s"),
    backoffCoefficient: 2,
    scheduleToCloseTimeout: new Duration(1_000_000, "ms"),
    maximumAttempts: 3,
    retries: [{ success: true, runtime: new Duration(5, "s") }],
  };
  const result = calculateResult(state);
  const tl = result.attemptTimeline;
  assert.equal(tl.length, 4);
  for (const a of tl.slice(0, 3)) {
    assert.equal(a.elapsedMS, 2000);
    assert.equal(a.outcome, "timedOut");
  }
  assert.equal(tl[3].outcome, "notUsed");
});

test("calculateResult: lastAttemptOutcome reflects the final attempt's outcome", () => {
  // Success: lastAttemptOutcome = "succeeded".
  const successResult = calculateResult({
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(1_000_000, "ms"),
    retries: [{ success: true, runtime: new Duration(100, "ms") }],
  });
  assert.equal(successResult.lastAttemptOutcome, "succeeded");

  // maximumAttempts hit on a startToCloseTimeout-killed attempt: outcome is
  // "timedOut" so the workflow history event type stays ActivityTaskTimedOut.
  const timedOutResult = calculateResult({
    ...DEFAULTS,
    startToCloseTimeout: new Duration(2, "s"),
    scheduleToCloseTimeout: new Duration(1_000_000, "ms"),
    maximumAttempts: 2,
    retries: [{ success: true, runtime: new Duration(5, "s") }],
  });
  assert.equal(timedOutResult.lastAttemptOutcome, "timedOut");
  assert.equal(timedOutResult.reason, "maximumAttempts");

  // Plain failed attempt at maximumAttempts: outcome "failed".
  const failedResult = calculateResult({
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(1_000_000, "ms"),
    maximumAttempts: 1,
    retries: [{ success: false, runtime: new Duration(100, "ms") }],
  });
  assert.equal(failedResult.lastAttemptOutcome, "failed");
  assert.equal(failedResult.reason, "maximumAttempts");
});

test("calculateResult caps attemptTimeline at the hardcoded limit", () => {
  // 200 attempts > 100-entry cap; only the first 100 should appear in the
  // timeline while the reported total attempt count is unaffected.
  const state = {
    ...DEFAULTS,
    initialInterval: new Duration(1, "ms"),
    backoffCoefficient: 1,
    scheduleToCloseTimeout: new Duration(1_000_000, "ms"),
    maximumAttempts: 200,
    retries: [{ success: false, runtime: new Duration(1, "ms") }],
  };
  const result = calculateResult(state);
  assert.equal(result.attemptTimeline.length, 100);
  assert.equal(result.attempts, 200);
});

test("never-terminating chain still populates attemptTimeline", () => {
  // Classic infinite retry: failure-only chain, no maximumAttempts, no
  // scheduleToCloseTimeout. The result is neverTerminates, but the timeline
  // should still show the first projected attempts so the chart isn't blank.
  const state = {
    ...DEFAULTS,
    scheduleToCloseTimeout: new Duration(0, "s"),
    initialInterval: new Duration(1, "s"),
    backoffCoefficient: 2,
    maximumAttempts: 0,
    retries: [{ success: false, runtime: new Duration(100, "ms") }],
  };
  const result = calculateResult(state);
  assert.equal(result.success, null);
  assert.equal(result.reason, "neverTerminates");
  assert.equal(result.attempts, Infinity);
  assert.equal(result.attemptTimeline.length, 100);
  assert.ok(result.attemptTimeline.every((a) => a.outcome === "failed"));
});

test("crashLoopAttempts: returns 1 when no startToCloseTimeout but a scheduleToCloseTimeout is set", () => {
  // DEFAULTS has scheduleToCloseTimeout=24h with no startToCloseTimeout — a
  // crashed Worker never releases the in-flight attempt, so a single attempt
  // consumes the whole 24h window.
  assert.equal(crashLoopAttempts(DEFAULTS), 1);
});

test("crashLoopAttempts: returns Infinity when neither timeout is set", () => {
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: new Duration(0, "s"),
    scheduleToCloseTimeout: new Duration(0, "s"),
  };
  assert.equal(crashLoopAttempts(state), Infinity);
});

test("crashLoopAttempts: returns Infinity when no scheduleToCloseTimeout caps the chain", () => {
  // STC set, but no STT and unlimited maxAttempts → calculateResult bails as
  // never-terminates and the worst case is unbounded.
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: new Duration(1, "s"),
    scheduleToCloseTimeout: new Duration(0, "s"),
    maximumAttempts: 0,
  };
  assert.equal(crashLoopAttempts(state), Infinity);
});

test("crashLoopAttempts: uses heartbeatTimeout as the per-attempt cap when set", () => {
  // Heartbeat fires faster than start-to-close on a crashed Worker, so the
  // calculation should bind to heartbeatTimeout (1s) instead of the much
  // larger startToCloseTimeout (5m). With initialInterval=0 and backoff=1,
  // each cycle is 1s + 0s ≈ 1s; STT=10s allows 10 cycles.
  const state = {
    ...DEFAULTS,
    heartbeatTimeout: new Duration(1, "s"),
    startToCloseTimeout: new Duration(5, "m"),
    scheduleToCloseTimeout: new Duration(10, "s"),
    initialInterval: new Duration(0, "ms"),
    backoffCoefficient: 1,
    maximumInterval: new Duration(0, "s"),
    maximumAttempts: 0,
  };
  assert.equal(crashLoopAttempts(state), 10);
});

test("crashLoopAttempts: counts attempts that fit inside scheduleToCloseTimeout", () => {
  // Each attempt: 1s STC. Initial interval 1s, backoff 1, maximumInterval 1s
  // → cycle length 2s. STT=10s → 5 cycles fit. Attempt 6 starts at 10s
  // and the post-attempt check ends the chain at scheduleToCloseTimeout.
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: new Duration(1, "s"),
    scheduleToCloseTimeout: new Duration(10, "s"),
    initialInterval: new Duration(1, "s"),
    backoffCoefficient: 1,
    maximumInterval: new Duration(1, "s"),
    maximumAttempts: 0,
  };
  assert.equal(crashLoopAttempts(state), 5);
});

test("crashLoopAttempts: returns the smaller of maxAttempts and the STT-bound count", () => {
  // STT alone would allow 5 cycles (see test above), but maxAttempts caps at 3.
  const state = {
    ...DEFAULTS,
    startToCloseTimeout: new Duration(1, "s"),
    scheduleToCloseTimeout: new Duration(10, "s"),
    initialInterval: new Duration(1, "s"),
    backoffCoefficient: 1,
    maximumInterval: new Duration(1, "s"),
    maximumAttempts: 3,
  };
  assert.equal(crashLoopAttempts(state), 3);
});

test("zeroDelayExhaustionMS: returns Infinity when maximumAttempts is unlimited", () => {
  assert.equal(zeroDelayExhaustionMS(DEFAULTS), Infinity);
});

test("zeroDelayExhaustionMS: returns 0 when maximumAttempts is 1 (no retry intervals)", () => {
  const state = { ...DEFAULTS, maximumAttempts: 1 };
  assert.equal(zeroDelayExhaustionMS(state), 0);
});

test("zeroDelayExhaustionMS: sums backoff intervals, capped at maximumInterval", () => {
  // 5 attempts with initialInterval=1s, backoff=2, maximumInterval=4s.
  // The simulator's first interval is initial * backoff (= 2s), so intervals
  // for attempts 2..5 are: 2s, 4s, 4s, 4s — total 14s.
  const state = {
    ...DEFAULTS,
    initialInterval: new Duration(1, "s"),
    backoffCoefficient: 2,
    maximumInterval: new Duration(4, "s"),
    maximumAttempts: 5,
    scheduleToCloseTimeout: new Duration(24, "h"),
  };
  assert.equal(zeroDelayExhaustionMS(state), 14000);
});

test("zeroDelayExhaustionMS: returns Infinity once maximumAttempts exceeds the iteration guard", () => {
  const state = {
    ...DEFAULTS,
    initialInterval: new Duration(1, "ms"),
    backoffCoefficient: 1,
    maximumInterval: new Duration(1, "ms"),
    maximumAttempts: 5000,
    scheduleToCloseTimeout: new Duration(24, "h"),
  };
  assert.equal(zeroDelayExhaustionMS(state), Infinity);
});
